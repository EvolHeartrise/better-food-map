/**
 * Bench run harness.
 *
 * Drives an OpenAI-compatible tool-calling model (via OpenRouter) against a
 * frozen website snapshot and scores the menu it extracts. The model never
 * touches the real network: its only tools are `fetch_page` (served entirely
 * in-process from the task's SnapshotStore) and `submit_menu` (validated
 * against the scorer's CandidateSchema). The submitted extraction is scored
 * with the same deterministic scorer as `bench:score`.
 *
 * Usage:
 *   bun run bench:run <task-dir> --model <openrouter-model-id> [--max-tool-calls N]
 *
 * Requires OPENROUTER_API_KEY in the environment. Writes a run directory under
 * bench/runs/<task-slug>/<iso-timestamp>-<model-slug>/ (bench/ is gitignored).
 * Exit 0 on a scored run, 1 on a failed run, 2 on usage/config errors.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as v from 'valibot';
import { DIETARY_TAGS, GoldSchema, htmlToText, type GoldMenu } from './lint';
import { CandidateSchema, formatSummary, scoreCandidate, type ScoreReport } from './score';
import {
	findEntry,
	loadManifest,
	normalizeUrl,
	SnapshotStore,
	type SnapshotEntry
} from './snapshot-store';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_CAP = 60_000;
const DEFAULT_MAX_TOOL_CALLS = 40;
const MAX_SUBMIT_ATTEMPTS = 3;
const MAX_HTTP_RETRIES = 3;

// --- OpenAI-compatible chat shapes (only the fields the harness reads) --------

export interface ChatToolCall {
	id: string;
	type?: string;
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
}

export interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

export interface ChatResponse {
	choices: { message: ChatMessage }[];
	usage?: ChatUsage;
}

/** Injected model driver: given the running message list, return one response. */
export type ChatFn = (messages: ChatMessage[]) => Promise<ChatResponse>;

// --- fetch_page tool ----------------------------------------------------------

const HREF_RE = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** All a[href] targets in the html, resolved against baseUrl, deduped, all hosts. */
export function extractHrefs(html: string, baseUrl: string): string[] {
	const out = new Set<string>();
	for (const match of html.matchAll(HREF_RE)) {
		const raw = match[2] ?? match[3] ?? match[4];
		if (!raw) continue;
		try {
			const u = new URL(raw, baseUrl);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
			u.hash = '';
			out.add(u.href);
		} catch {
			// unresolvable href — skip
		}
	}
	return [...out];
}

/** Collapse runs of whitespace produced by htmlToText into readable text. */
function collapseText(text: string): string {
	return text
		.replace(/[^\S\n]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Cap a returned text body, appending an explicit truncation marker when cut. */
export function capText(text: string): string {
	if (text.length <= TEXT_CAP) return text;
	return `${text.slice(0, TEXT_CAP)}\n[truncated: ${TEXT_CAP} of ${text.length} chars]`;
}

function bareType(contentType: string | null): string {
	return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** Resolve a GET entry, trying the url as given then with its scheme swapped. */
function resolveEntry(store: SnapshotStore, url: string): SnapshotEntry | undefined {
	const direct = findEntry(store.index, 'GET', url);
	if (direct) return direct;
	try {
		const u = new URL(url);
		u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
		return findEntry(store.index, 'GET', u.href);
	} catch {
		return undefined;
	}
}

export type FetchPageResult =
	| { status: number; note: string }
	| { url: string; status: number; text: string; links?: string[] };

/** Serve one fetch_page call entirely from the snapshot — no real network. */
export function fetchPage(store: SnapshotStore, rawUrl: string): FetchPageResult {
	let normUrl: string;
	try {
		normUrl = normalizeUrl(rawUrl);
	} catch {
		return { status: 404, note: 'not in snapshot' };
	}
	const entry = resolveEntry(store, normUrl);
	if (!entry) return { status: 404, note: 'not in snapshot' };

	const type = bareType(entry.contentType);
	const rendered = store.renderedHtml(entry);
	const bodyBytes = store.body(entry);
	const bodyText = bodyBytes ? new TextDecoder().decode(bodyBytes) : undefined;

	// HTML: prefer the rendered DOM over the raw body; extract links from the
	// SAME html we convert to text so the model sees a matching link set.
	if (type === 'text/html' || rendered !== undefined) {
		const html = rendered ?? bodyText ?? '';
		const text = capText(collapseText(htmlToText(html)));
		return { url: entry.url, status: entry.status, text, links: extractHrefs(html, entry.url) };
	}

	if (type === 'application/pdf') {
		return {
			url: entry.url,
			status: entry.status,
			text: `[PDF document, ${entry.size} bytes — text extraction not supported by this harness yet]`
		};
	}

	if (bodyText !== undefined) {
		return { url: entry.url, status: entry.status, text: capText(bodyText) };
	}

	return {
		url: entry.url,
		status: entry.status,
		text: `[${type || 'binary'} response, ${entry.size} bytes — no text body]`
	};
}

// --- submit_menu tool ---------------------------------------------------------

export type SubmitResult =
	| { ok: true; candidate: v.InferOutput<typeof CandidateSchema> }
	| { ok: false; issues: string[] };

/** Validate a submit_menu payload against the scorer's CandidateSchema. */
export function validateSubmission(payload: unknown): SubmitResult {
	const parsed = v.safeParse(CandidateSchema, payload);
	if (parsed.success) return { ok: true, candidate: parsed.output };
	return {
		ok: false,
		issues: parsed.issues
			.slice(0, 20)
			.map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
	};
}

// --- tool definitions sent to the model --------------------------------------

const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'fetch_page',
			description:
				'Fetch a page from the restaurant website snapshot. Returns the page text and, ' +
				'for HTML pages, a list of links found on the page. Use it to navigate the site and ' +
				'discover every menu page. URLs not in the snapshot return status 404.',
			parameters: {
				type: 'object',
				properties: { url: { type: 'string', description: 'Absolute URL to fetch.' } },
				required: ['url']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'submit_menu',
			description:
				'Submit your final, exhaustive menu extraction. Call this exactly once when done.',
			parameters: {
				type: 'object',
				properties: {
					sources: {
						type: 'array',
						items: { type: 'string' },
						description: 'Every URL the menu data actually came from.'
					},
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								description: {
									type: ['string', 'null'],
									description: "The venue's own menu text verbatim, else null."
								},
								tags: {
									type: 'array',
									items: { type: 'string', enum: [...DIETARY_TAGS] },
									description: 'Source-asserted dietary tags only.'
								},
								optional_tags: {
									type: 'array',
									items: { type: 'string', enum: [...DIETARY_TAGS] },
									description: 'Dietary designations that hold only on request.'
								},
								price: { type: ['number', 'null'] }
							},
							required: ['name', 'description', 'tags', 'optional_tags', 'price']
						}
					}
				},
				required: ['sources', 'items']
			}
		}
	}
];

const SYSTEM_PROMPT = [
	'You are extracting a restaurant’s FULL menu from a snapshot of its website, served to you through the fetch_page tool. You have no other access to the site.',
	'',
	'Rules:',
	'- The menu must be EXHAUSTIVE: capture every item, in every section (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials), and every size/variant the source itemizes. Do not submit a representative sample.',
	'- The menu is routinely split across MULTIPLE pages or tabs (a separate drinks, dessert, brunch, lunch/dinner, or specials page). Follow the links returned by fetch_page and enumerate every menu-shaped page BEFORE you finish. A menu with zero drinks or zero desserts for a sit-down venue almost always means you missed a page.',
	'- The six dietary tags are vegan, vegetarian, gluten_free, dairy_free, nut_free, and halal. They are SOURCE-ASSERTED ONLY: apply a tag to an item only when the source explicitly designates it — through a dietary label/marker or in the item’s displayed name (e.g. "Vegan Burger"). NEVER infer a tag from general knowledge of the dish. NEVER derive a free-of tag (gluten_free/nut_free/dairy_free) from the ABSENCE of an allergen symbol — an allergen legend marks presence, never freedom-from.',
	'- optional_tags are designations that hold only on request (e.g. "can be made vegan"). A tag never appears in both tags and optional_tags.',
	'- description is the venue’s own menu text for the item, verbatim; if the source gives none, use null. Do not write your own descriptions.',
	'- price is a number (in the source’s currency) or null when the source shows no price.',
	'- sources is every URL the menu data actually came from.',
	'',
	'Work by fetching pages, then call submit_menu exactly once with your final extraction.'
].join('\n');

// --- the agent loop -----------------------------------------------------------

export interface TranscriptEvent {
	type: 'request' | 'response' | 'tool_call' | 'tool_result' | 'note';
	ts: string;
	[key: string]: unknown;
}

export interface RunResult {
	status: 'scored' | 'failed';
	failureReason?: string;
	candidate?: v.InferOutput<typeof CandidateSchema>;
	toolCalls: number;
	submitAttempts: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (e) {
		return { ok: false, error: `arguments were not valid JSON: ${String(e)}` };
	}
}

/**
 * Drive the tool-calling loop against an injected `chat` function. Pure with
 * respect to the network: `chat` is the only thing that talks to a model, and
 * every tool call is served from `store`. Appends structured events to
 * `transcript` as it goes so a failed run still leaves a replayable trail.
 */
export async function runAgent(opts: {
	chat: ChatFn;
	store: SnapshotStore;
	entryUrl: string;
	maxToolCalls: number;
	transcript: TranscriptEvent[];
}): Promise<RunResult> {
	const { chat, store, entryUrl, maxToolCalls, transcript } = opts;
	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: `The restaurant’s website entry URL is: ${entryUrl}` }
	];

	let toolCalls = 0;
	let submitAttempts = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let totalTokens = 0;
	let nudged = false;

	const done = (
		r: Omit<
			RunResult,
			'toolCalls' | 'submitAttempts' | 'promptTokens' | 'completionTokens' | 'totalTokens'
		>
	): RunResult => ({
		...r,
		toolCalls,
		submitAttempts,
		promptTokens,
		completionTokens,
		totalTokens
	});

	for (;;) {
		transcript.push({
			type: 'request',
			ts: new Date().toISOString(),
			message_count: messages.length,
			last_role: messages[messages.length - 1].role
		});
		const response = await chat(messages);
		const usage = response.usage ?? {};
		promptTokens += usage.prompt_tokens ?? 0;
		completionTokens += usage.completion_tokens ?? 0;
		totalTokens += usage.total_tokens ?? 0;
		const message = response.choices[0]?.message;
		transcript.push({
			type: 'response',
			ts: new Date().toISOString(),
			usage,
			message: message ?? null
		});
		if (!message) {
			return done({ status: 'failed', failureReason: 'model returned no message' });
		}
		messages.push(message);

		const toolCallList = message.tool_calls ?? [];
		if (toolCallList.length === 0) {
			if (!nudged) {
				nudged = true;
				transcript.push({ type: 'note', ts: new Date().toISOString(), note: 'nudged for submit' });
				messages.push({
					role: 'user',
					content: 'You must call submit_menu with your final extraction.'
				});
				continue;
			}
			return done({
				status: 'failed',
				failureReason: 'model stopped calling tools without submitting'
			});
		}

		for (const call of toolCallList) {
			toolCalls += 1;
			if (toolCalls > maxToolCalls) {
				return done({
					status: 'failed',
					failureReason: `exceeded max tool calls (${maxToolCalls})`
				});
			}
			const parsed = parseArguments(call.function.arguments);
			transcript.push({
				type: 'tool_call',
				ts: new Date().toISOString(),
				id: call.id,
				name: call.function.name,
				arguments: parsed.ok ? parsed.value : call.function.arguments
			});

			let result: unknown;
			if (!parsed.ok) {
				result = { error: parsed.error };
			} else if (call.function.name === 'fetch_page') {
				const args = parsed.value as { url?: unknown };
				result =
					typeof args.url === 'string'
						? fetchPage(store, args.url)
						: { error: 'fetch_page requires a string "url" argument' };
			} else if (call.function.name === 'submit_menu') {
				submitAttempts += 1;
				const submission = validateSubmission(parsed.value);
				if (submission.ok) {
					transcript.push({
						type: 'tool_result',
						ts: new Date().toISOString(),
						id: call.id,
						name: call.function.name,
						result: { ok: true }
					});
					return done({ status: 'scored', candidate: submission.candidate });
				}
				result = { ok: false, issues: submission.issues };
				if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
					transcript.push({
						type: 'tool_result',
						ts: new Date().toISOString(),
						id: call.id,
						name: call.function.name,
						result
					});
					return done({
						status: 'failed',
						failureReason: `submit_menu failed validation ${MAX_SUBMIT_ATTEMPTS} times`
					});
				}
			} else {
				result = { error: `unknown tool: ${call.function.name}` };
			}

			transcript.push({
				type: 'tool_result',
				ts: new Date().toISOString(),
				id: call.id,
				name: call.function.name,
				result
			});
			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				content: JSON.stringify(result)
			});
		}
	}
}

// --- OpenRouter chat driver ---------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Real model driver: POST to OpenRouter, retrying 429/5xx with backoff. */
export function openRouterChat(model: string, apiKey: string): ChatFn {
	return async (messages: ChatMessage[]): Promise<ChatResponse> => {
		const body = JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto' });
		let lastError = '';
		for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
			let res: Response;
			try {
				res = await fetch(OPENROUTER_URL, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json'
					},
					body
				});
			} catch (e) {
				lastError = `network error: ${String(e)}`;
				if (attempt < MAX_HTTP_RETRIES) {
					await sleep(2 ** attempt * 1000);
					continue;
				}
				throw new Error(`OpenRouter request failed: ${lastError}`);
			}
			if (res.ok) return (await res.json()) as ChatResponse;
			const text = await res.text();
			if ((res.status === 429 || res.status >= 500) && attempt < MAX_HTTP_RETRIES) {
				await sleep(2 ** attempt * 1000);
				continue;
			}
			throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
		}
		throw new Error(`OpenRouter request failed after retries: ${lastError}`);
	};
}

// --- output assembly ----------------------------------------------------------

export function modelSlug(model: string): string {
	return model.replace(/[/:]/g, '-');
}

export interface RunMeta {
	model: string;
	task_dir: string;
	entry_url: string;
	policy_version: string;
	started_at: string;
	duration_ms: number;
	tool_calls: number;
	submit_attempts: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	status: 'scored' | 'failed';
	failure_reason?: string;
}

function writeRun(
	runDir: string,
	parts: {
		meta: RunMeta;
		transcript: TranscriptEvent[];
		candidate?: v.InferOutput<typeof CandidateSchema>;
		report?: ScoreReport;
	}
): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, 'meta.json'), JSON.stringify(parts.meta, null, '\t'));
	writeFileSync(
		join(runDir, 'transcript.jsonl'),
		parts.transcript.map((e) => JSON.stringify(e)).join('\n') + '\n'
	);
	if (parts.candidate) {
		writeFileSync(join(runDir, 'candidate.json'), JSON.stringify(parts.candidate, null, '\t'));
	}
	if (parts.report) {
		writeFileSync(join(runDir, 'report.json'), JSON.stringify(parts.report, null, '\t'));
	}
}

// --- CLI ----------------------------------------------------------------------

interface CliArgs {
	taskDir: string;
	model: string;
	maxToolCalls: number;
}

function parseCli(argv: string[]): CliArgs | { error: string } {
	let taskDir: string | undefined;
	let model: string | undefined;
	let maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--model') {
			model = argv[++i];
		} else if (arg === '--max-tool-calls') {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0)
				return { error: '--max-tool-calls must be a positive integer' };
			maxToolCalls = n;
		} else if (arg.startsWith('--')) {
			return { error: `unknown option: ${arg}` };
		} else if (taskDir === undefined) {
			taskDir = arg;
		} else {
			return { error: `unexpected argument: ${arg}` };
		}
	}
	if (!taskDir) return { error: 'missing <task-dir>' };
	if (!model) return { error: 'missing --model <openrouter-model-id>' };
	return { taskDir, model, maxToolCalls };
}

async function main(): Promise<number> {
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(
			'usage: bun run bench:run <task-dir> --model <openrouter-model-id> [--max-tool-calls N]'
		);
		return 2;
	}

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.error('error: OPENROUTER_API_KEY is not set');
		return 2;
	}

	const manifest = loadManifest(cli.taskDir);
	if (!manifest) {
		console.error(`error: no manifest.json in ${cli.taskDir} — record a snapshot first`);
		return 2;
	}

	const goldPath = join(cli.taskDir, 'gold', 'data.json');
	if (!existsSync(goldPath)) {
		console.error(`error: no gold/data.json in ${cli.taskDir}`);
		return 2;
	}
	let gold: GoldMenu;
	try {
		const parsed = v.safeParse(GoldSchema, JSON.parse(readFileSync(goldPath, 'utf-8')));
		if (!parsed.success) {
			console.error(`error: gold/data.json is invalid: ${parsed.issues[0]?.message ?? 'unknown'}`);
			return 2;
		}
		gold = parsed.output;
	} catch (e) {
		console.error(`error: could not read gold/data.json: ${String(e)}`);
		return 2;
	}

	const store = new SnapshotStore(join(cli.taskDir, 'snapshot'));
	const transcript: TranscriptEvent[] = [];
	const startedAt = new Date();
	const runDir = join(
		'bench',
		'runs',
		basename(cli.taskDir),
		`${startedAt.toISOString()}-${modelSlug(cli.model)}`
	);

	let result: RunResult;
	try {
		result = await runAgent({
			chat: openRouterChat(cli.model, apiKey),
			store,
			entryUrl: manifest.entryUrl,
			maxToolCalls: cli.maxToolCalls,
			transcript
		});
	} catch (e) {
		const meta: RunMeta = {
			model: cli.model,
			task_dir: cli.taskDir,
			entry_url: manifest.entryUrl,
			policy_version: gold.policy_version,
			started_at: startedAt.toISOString(),
			duration_ms: Date.now() - startedAt.getTime(),
			tool_calls: 0,
			submit_attempts: 0,
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			status: 'failed',
			failure_reason: String(e)
		};
		writeRun(runDir, { meta, transcript });
		console.error(`run failed: ${String(e)}`);
		console.error(`run directory: ${runDir}`);
		return 1;
	}

	const report = result.candidate ? scoreCandidate(gold, result.candidate) : undefined;
	const meta: RunMeta = {
		model: cli.model,
		task_dir: cli.taskDir,
		entry_url: manifest.entryUrl,
		policy_version: gold.policy_version,
		started_at: startedAt.toISOString(),
		duration_ms: Date.now() - startedAt.getTime(),
		tool_calls: result.toolCalls,
		submit_attempts: result.submitAttempts,
		prompt_tokens: result.promptTokens,
		completion_tokens: result.completionTokens,
		total_tokens: result.totalTokens,
		status: result.status,
		failure_reason: result.failureReason
	};
	writeRun(runDir, { meta, transcript, candidate: result.candidate, report });

	if (report) console.error(formatSummary(report));
	else console.error(`run failed: ${result.failureReason ?? 'unknown'}`);
	console.error(`run directory: ${runDir}`);
	return result.status === 'scored' ? 0 : 1;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(`fatal: ${String(e)}`);
			process.exit(1);
		});
}
