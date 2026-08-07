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
 *   bun run bench:run <task-dir> --model <model-id>
 *     [--backend openrouter|claude] [--effort <level>] [--temperature <n>] [--max-tool-calls N]
 *
 * Requires OPENROUTER_API_KEY in the environment. Writes a run directory under
 * bench/runs/<task-slug>/<iso-timestamp>-<model-slug>/ (bench/ is gitignored).
 * Exit 0 on a scored run, 1 on a failed run, 2 on usage/config errors, 3 when the
 * model/config is blacklisted (see blacklist.ts) and the run was skipped unspent.
 */
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as v from 'valibot';
import {
	describeEntry,
	findBlock,
	formatBlocked,
	loadBlacklist,
	type BlacklistEntry
} from './blacklist';
import { DIETARY_TAGS, GoldSchema, htmlToText, type GoldMenu } from './lint';
import { CandidateSchema, formatSummary, scoreCandidate, type ScoreReport } from './score';
import {
	findEntry,
	loadManifest,
	normalizeUrl,
	SnapshotStore,
	type BenchManifest,
	type SnapshotEntry
} from './snapshot-store';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_CAP = 60_000;
const DEFAULT_MAX_TOOL_CALLS = 40;
const MAX_SUBMIT_ATTEMPTS = 3;
const MAX_HTTP_RETRIES = 3;

/**
 * Reasoning-effort levels accepted per backend. OpenRouter's unified reasoning
 * parameter (`reasoning: { effort }`) documents `none | minimal | low | medium |
 * high | xhigh | max`; the Claude Agent SDK's `Options.effort` (EffortLevel)
 * accepts `low | medium | high | xhigh | max` (no none/minimal). Each backend
 * validates `--effort` against its own set, so the error names the right levels.
 */
export const OPENROUTER_EFFORT_LEVELS = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max'
] as const;
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function effortLevelsFor(backend: Backend): readonly string[] {
	return backend === 'claude' ? CLAUDE_EFFORT_LEVELS : OPENROUTER_EFFORT_LEVELS;
}

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

/** An OpenAI/OpenRouter content part — only text parts are produced here. */
export interface MessageContentPart {
	type: 'text';
	text: string;
	cache_control?: { type: 'ephemeral' };
}

/**
 * An outbound message as sent to OpenRouter: identical to a ChatMessage except
 * the Anthropic cache transform may rewrite `content` into an array of content
 * parts to carry `cache_control` breakpoints (see `withAnthropicCache`).
 */
export interface OutboundMessage extends Omit<ChatMessage, 'content'> {
	content?: string | null | MessageContentPart[];
}

export interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	/** OpenRouter surfaces cache-read tokens here for prompt-cached prefixes. */
	prompt_tokens_details?: { cached_tokens?: number };
	/** Anthropic-style cache accounting, when the provider reports it. */
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	/**
	 * REAL billed cost of THIS request in USD, surfaced by OpenRouter when usage
	 * accounting is enabled (`usage: { include: true }`). OpenRouter credits are
	 * denominated in USD, so this is dollars. `cost_details` breaks the same total
	 * down (upstream inference cost); we read the top-level `cost` defensively.
	 */
	cost?: number;
	cost_details?: { upstream_inference_cost?: number };
}

/** Cached-prompt / cache-write tokens read defensively from a usage object. */
export function readCacheTokens(usage: ChatUsage): { cached: number; write: number } {
	const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
	const write = usage.cache_creation_input_tokens ?? 0;
	return { cached, write };
}

// --- run cost accounting (openrouter backend) --------------------------------

/**
 * Per-token USD rates for one model, read from OpenRouter's public models list.
 * `cacheRead` falls back to the prompt rate (no discount) when the model exposes
 * no `input_cache_read` price.
 */
export interface ModelPricing {
	/** USD per prompt (input) token. */
	prompt: number;
	/** USD per completion (output) token. */
	completion: number;
	/** USD per cache-read (cached prompt) token. */
	cacheRead: number;
}

/**
 * Sum the REAL billed cost of a run: the per-request `usage.cost` values
 * OpenRouter returns (USD) when usage accounting is enabled. Returns null when
 * NO request carried a numeric cost (so an absent cost is distinguishable from a
 * genuine $0 run). Requests missing `cost` are skipped, not treated as zero.
 */
export function sumRealCost(usages: ChatUsage[]): number | null {
	let sum = 0;
	let seen = false;
	for (const u of usages) {
		if (typeof u.cost === 'number' && Number.isFinite(u.cost)) {
			sum += u.cost;
			seen = true;
		}
	}
	return seen ? sum : null;
}

/**
 * HYPOTHETICAL cost of the same run under PERFECT prefix caching.
 *
 * The bench loop is append-only: request i's prompt is request i-1's prompt plus
 * new tokens. We assume every token of request i's prompt that was ALREADY in
 * request i-1's prompt is billed at the model's cache-read rate, the remainder at
 * the normal prompt (input) rate, and completions at the output rate. Request 1
 * is fully uncached. Cache-WRITE premiums are ignored (idealized lower bound).
 *
 * `promptTotal` is the FULL prompt size of the request (OpenRouter's
 * `prompt_tokens`, which INCLUDES any cached prefix — `cached_tokens` is a subset
 * of it), so request i's cached portion is min(prev, curr) tokens and its fresh
 * portion is max(0, curr - prev). Pure: pricing + the usage sequence only.
 */
export function estimateCachedPrice(
	perRequestUsage: { promptTotal: number; completion: number }[],
	pricing: ModelPricing
): number {
	let total = 0;
	let prevPrompt = 0;
	for (let i = 0; i < perRequestUsage.length; i += 1) {
		const { promptTotal, completion } = perRequestUsage[i];
		if (i === 0) {
			total += promptTotal * pricing.prompt;
		} else {
			const cached = Math.min(prevPrompt, promptTotal);
			const fresh = Math.max(0, promptTotal - prevPrompt);
			total += cached * pricing.cacheRead + fresh * pricing.prompt;
		}
		total += completion * pricing.completion;
		prevPrompt = promptTotal;
	}
	return total;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Quantization tiers OpenRouter recognises for `provider.quantizations`.
 * Validated client-side so a typo (`fp-8`) fails before spending, rather than
 * silently widening routing back to every endpoint.
 */
export const QUANTIZATION_LEVELS = [
	'int4',
	'int8',
	'fp4',
	'fp6',
	'fp8',
	'fp16',
	'bf16',
	'fp32',
	'unknown'
] as const;

/**
 * Map provider name → quantization for one model, from OpenRouter's public
 * endpoints list. Best-effort: returns an empty map on any failure, since a
 * network blip must never fail a completed run — the provider names are still
 * recorded either way.
 */
export async function fetchProviderQuantizations(model: string): Promise<Record<string, string>> {
	try {
		const res = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
			headers: { Accept: 'application/json' }
		});
		if (!res.ok) return {};
		const body = (await res.json()) as {
			data?: { endpoints?: { provider_name?: unknown; quantization?: unknown }[] };
		};
		const out: Record<string, string> = {};
		for (const e of body.data?.endpoints ?? []) {
			if (typeof e.provider_name === 'string' && typeof e.quantization === 'string') {
				out[e.provider_name] = e.quantization;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * One model's entry from OpenRouter's public models endpoint, reduced to the two
 * fields the harness reads: per-token `pricing` (null when the price fields are
 * missing/unparseable) and the `supportedParameters` allowlist (null when the
 * model exposes none). Fetched ONCE per run and shared by the run-cost accounting
 * and the pre-flight parameter validation.
 */
export interface ModelInfo {
	pricing: ModelPricing | null;
	supportedParameters: string[] | null;
}

/**
 * Parse one model's per-token pricing from its models-endpoint `pricing` object.
 * Returns null when the prompt/completion rates are missing or unparseable; a
 * missing `input_cache_read` is tolerated by falling back to the prompt rate
 * (noted on stderr). Pure aside from that one stderr note.
 */
function parseModelPricing(
	model: string,
	p: Record<string, string | undefined> | undefined
): ModelPricing | null {
	if (!p) return null;
	const prompt = Number(p.prompt);
	const completion = Number(p.completion);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
	const cacheReadRaw = p.input_cache_read;
	const cacheRead = Number(cacheReadRaw);
	if (cacheReadRaw === undefined || !Number.isFinite(cacheRead)) {
		console.error(
			`note: model ${model} exposes no input_cache_read price — using the prompt rate for cached tokens (no cache discount)`
		);
		return { prompt, completion, cacheRead: prompt };
	}
	return { prompt, completion, cacheRead };
}

/**
 * Fetch one model's pricing + `supported_parameters` from OpenRouter's public
 * models endpoint, in ONE request shared by the cost accounting and the
 * pre-flight parameter validation. Returns null on ANY fetch/parse failure or a
 * missing model id (the same failure modes the old `fetchModelPricing` tolerated
 * → `price_cached` null AND validation skipped). CLI-only — never called from
 * tests (it hits the net); the pure `validateRequestedParams` is the unit seam.
 */
export async function fetchModelInfo(model: string): Promise<ModelInfo | null> {
	let data: {
		data?: {
			id?: string;
			pricing?: Record<string, string | undefined>;
			supported_parameters?: unknown;
		}[];
	};
	try {
		const res = await fetch(OPENROUTER_MODELS_URL);
		if (!res.ok) return null;
		data = (await res.json()) as typeof data;
	} catch {
		return null;
	}
	const entry = data.data?.find((m) => m.id === model);
	if (!entry) return null;
	const sp = entry.supported_parameters;
	const supportedParameters =
		Array.isArray(sp) && sp.every((x) => typeof x === 'string') ? sp : null;
	return { pricing: parseModelPricing(model, entry.pricing), supportedParameters };
}

/**
 * Pre-flight check that the requested reasoning/sampling knobs are ones the model
 * actually accepts, per its OpenRouter `supported_parameters` allowlist. Pure and
 * network-free: the model id is deliberately kept OUT of the signature (the caller
 * composes the model-named message). Returns a human-readable error string when a
 * requested knob is unsupported, or null when everything requested is fine OR when
 * support is UNKNOWABLE (`supportedParameters` is null — a missing/unfetchable
 * allowlist never blocks a run the provider might accept). `--effort` needs either
 * `reasoning` or `reasoning_effort`; `--temperature` needs `temperature`.
 */
export function validateRequestedParams(
	requested: { effort?: string; temperature?: number },
	supportedParameters: string[] | null
): string | null {
	if (supportedParameters === null) return null;
	const list = supportedParameters.join(', ');
	if (
		requested.effort !== undefined &&
		!supportedParameters.includes('reasoning') &&
		!supportedParameters.includes('reasoning_effort')
	) {
		return `does not support reasoning effort (--effort); supported_parameters: ${list}`;
	}
	if (requested.temperature !== undefined && !supportedParameters.includes('temperature')) {
		return `does not support temperature (--temperature); supported_parameters: ${list}`;
	}
	return null;
}

// --- Anthropic prompt-cache breakpoints (OpenRouter passes cache_control through) --

const EPHEMERAL = { type: 'ephemeral' } as const;

/** One text part carrying the ephemeral cache breakpoint. */
function cachedTextBlock(text: string): MessageContentPart[] {
	return [{ type: 'text', text, cache_control: EPHEMERAL }];
}

/**
 * Return a copy of `messages` with Anthropic prompt-cache breakpoints attached,
 * WITHOUT mutating the caller's array or any of its message objects (the agent
 * loop reuses the same array across turns, and the rolling breakpoint has to
 * move each request). Places at most TWO breakpoints (Anthropic allows 4):
 *
 *  1. A STATIC breakpoint on the system message (its content becomes a single
 *     cached text block) — the system prompt never changes, so this prefix is
 *     cacheable every turn.
 *  2. A ROLLING breakpoint on the LAST message that has text content (scanning
 *     from the end, index >= 1 so it never collides with the system breakpoint).
 *     We DO include tool-role messages here: OpenRouter documents cache_control
 *     passthrough on array-of-parts content for Anthropic tool messages, and in
 *     this loop the growing prefix ends on a tool result, so marking it is what
 *     actually caches each turn's new suffix. A pure tool-call assistant turn
 *     has null content and no text block, so it is skipped and the marker lands
 *     on the nearest preceding text-bearing message — keeping the choice
 *     deterministic and always on a real text block.
 */
export function withAnthropicCache(messages: ChatMessage[]): OutboundMessage[] {
	const copy: OutboundMessage[] = messages.map((m) => ({ ...m }));
	const sys = copy[0];
	if (sys && sys.role === 'system' && typeof sys.content === 'string' && sys.content.length > 0) {
		sys.content = cachedTextBlock(sys.content);
	}
	for (let i = copy.length - 1; i >= 1; i -= 1) {
		const m = copy[i];
		if (typeof m.content === 'string' && m.content.length > 0) {
			m.content = cachedTextBlock(m.content);
			break;
		}
	}
	return copy;
}

export interface ChatResponse {
	choices: { message: ChatMessage }[];
	usage?: ChatUsage;
	/**
	 * Which upstream provider OpenRouter actually routed this request to
	 * (e.g. `DeepInfra`, `Fireworks`). OpenRouter picks per request — cheapest
	 * first by default — and providers differ in BOTH price and quantization, so
	 * without this a run's numbers can't be attributed to the model alone.
	 */
	provider?: string;
	/** OpenRouter generation id — the handle for a later `/api/v1/generation` lookup. */
	id?: string;
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

/**
 * List-delimiter junk models occasionally leak onto the END of a submitted
 * string (a live run submitted `…potatoes.', ` — apostrophe/comma/space glued
 * onto otherwise-perfect text). Deterministic tail cleanup ONLY: no snapshot,
 * gold, or answer-key-adjacent data is ever consulted. Every submission is
 * treated identically.
 */
const TRAILING_JUNK_PUNCT = new Set([',', "'", '"', '`', '’', '‘', '“', '”']);

/** A char is trailing junk if it is whitespace or one of the delimiter marks. */
function isTrailingJunk(ch: string): boolean {
	return /\s/.test(ch) || TRAILING_JUNK_PUNCT.has(ch);
}

/**
 * Strip trailing list-delimiter junk from a string. Removes, from the END only,
 * any run of whitespace / `,` / quotes (straight and curly) / backtick; never
 * touches letters, digits, periods, or anything else, and never touches the
 * interior. Returns the original unchanged if stripping would empty it.
 */
export function stripTrailingJunk(text: string): string {
	let end = text.length;
	while (end > 0 && isTrailingJunk(text[end - 1])) end -= 1;
	if (end === 0) return text;
	return end === text.length ? text : text.slice(0, end);
}

export type SubmitResult =
	| { ok: true; candidate: v.InferOutput<typeof CandidateSchema> }
	| { ok: false; issues: string[] };

/**
 * Deterministic tail cleanup of leaked list-delimiter junk on a validated
 * candidate's descriptions — mutates in place. No snapshot/gold data consulted;
 * every submission is treated identically. Shared by both backends so a
 * successful submit is sanitized the same way regardless of how it arrived.
 */
export function applySubmitSanitation(candidate: v.InferOutput<typeof CandidateSchema>): void {
	for (const item of candidate.items) {
		if (item.description !== null) item.description = stripTrailingJunk(item.description);
	}
}

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
								price: { type: ['number', 'null'] },
								warning: {
									type: ['string', 'null'],
									description:
										'Terse note when a source label contradicts the item’s listed ingredients (e.g. a "Vegan" label on an item whose description lists paneer), else null/omit.'
								}
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

export const SYSTEM_PROMPT = [
	'You are extracting a restaurant’s FULL menu from a snapshot of its website, served to you through the fetch_page tool. You have no other access to the site.',
	'',
	'fetch_page returns the page’s text; `[image: …]` markers are the page’s own image alt text. Alt text is source text — a dish photo’s alt (e.g. "[image: Vegan Battered Cauliflower …]") is a valid source designation for the item it depicts. It is NOT menu prose: never use alt text as an item’s name or description.',
	'',
	'Rules:',
	'- The menu must be EXHAUSTIVE: capture every item, in every section (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials), and every size/variant the source itemizes. Do not submit a representative sample.',
	'- The menu is routinely split across MULTIPLE pages or tabs (a separate drinks, dessert, brunch, lunch/dinner, or specials page). Follow the links returned by fetch_page and enumerate every menu-shaped page BEFORE you finish. A menu with zero drinks or zero desserts for a sit-down venue almost always means you missed a page.',
	'- Add-ons, modifiers, and upsell options attached to an item ("Extra Chutney (Red)", "Add Noodles", "Make it Vegan", size upgrades priced as +$N) are NOT menu items — do not submit them as items. Where relevant they belong in the parent item’s data (e.g. an on-request dietary option → the parent’s optional_tags).',
	'- Name each item with its FULL name as displayed on its own line in the source, including any origin/appellation/producer qualifier that sits on that line (a wine listed "Stone Road Vineyards Smooth Red, BC VQA" keeps ", BC VQA"; "Villa Teresa Organic Merlot, Italy" keeps ", Italy"). Do not abbreviate or drop part of the displayed name.',
	'- A trailing parenthetical `(…)` on an item name is a qualifier YOU add, and it has exactly two uses, both defined below: a source-itemized size/serving variant, and a source-designated price context (Happy Hour, a day-of-week special). Never add one for any other reason.',
	'- When the source itemizes ONE dish at MULTIPLE prices (sizes, serving formats), submit ONE item per variant, named `<dish name exactly as displayed> (<variant label>)` using the source’s OWN word for the variant ("bowl", "cup", "5 oz", "bottle"). Never invent a size the source does not itemize, and an item sold at a single price gets NO size parenthetical. For a size variant the source shows as a measured volume plus vendor slang ("8oz halfer", "16 oz sleeve"), name it with just the measured volume — `(8 oz)`, `(16 oz)` — not the slang.',
	'- Two items may never share the same name. When a venue lists the SAME name for two genuinely different items (e.g. a poutine and a hot dog both called "Bacon Double Cheese"), distinguish them using the words the source itself gives you for the second one — its section, or how it is described on its own page.',
	'- A Happy Hour item is a source-designated price context, not a new dish: when the source lists an item on a Happy Hour menu/section (or otherwise marks it "Happy Hour"), submit it as its OWN item — distinct from any regular-menu version — carrying its Happy Hour price, and append the literal suffix ` (Happy Hour)` to the END of its name. This qualifier is REQUIRED on every Happy Hour item — it is the price-context use of the parenthetical listed above: `Sweet-Chili Cauliflower` becomes `Sweet-Chili Cauliflower (Happy Hour)`. When the item ALSO carries a size/serving-format variant label, `(Happy Hour)` goes LAST, after that label: `Stone Road Red Blend (5 oz glass) (Happy Hour)`.',
	'- A day-of-week drink special (an item under a "Daily Drink Specials" section, or one the source marks for specific days) is, like Happy Hour, a source-designated price context: submit it as its OWN item carrying the special price, and append ` (<Day> Daily Special)` to the END of its name, using the day label the source shows ("Monday", "Tuesday", …, "Friday/Saturday", "Sunday") — e.g. `House Lemonade (Monday Daily Special)`. When it also has a size label, the day suffix goes LAST: `Stone Road Red White & Rose (5 oz) (Wednesday Daily Special)`.',
	'- The six dietary tags are vegan, vegetarian, gluten_free, dairy_free, nut_free, and halal. They are SOURCE-ASSERTED ONLY: apply a tag to an item only when the source explicitly designates it — through a dietary label/marker or in the item’s displayed name (e.g. "Vegan Burger"). A designation the source asserts for the WHOLE venue or menu (e.g. a "100% Pure Vegetarian" heading, or a venue presenting itself as "plant-based" or "vegan" anywhere in the source — including an about/story/identity page, not only the menu) counts as a source assertion for every item it covers — tag each such item accordingly even when the item itself carries no individual label. A plant-based or vegan venue claim covers EVERY item on that menu — tag them all vegan, DRINKS INCLUDED (a vegetarian-only venue claim maps to vegetarian instead). NEVER infer a tag from general knowledge of the dish. NEVER derive a free-of tag (gluten_free/nut_free/dairy_free) from the ABSENCE of an allergen symbol — an allergen legend marks presence, never freedom-from. A designation must use the actual free-of/dietary term: hedged or softened phrasings ("gluten-friendly", "plant-forward", "vegan-ish", "nut-conscious") are NOT designations and support NO tag, mandatory or optional — when a venue avoids the real term, respect that choice ("plant-forward" is a hedge — mostly-but-not-only plants; a fully "plant-based" or "vegan" venue claim is the opposite and DOES designate vegan menu-wide, per the whole-venue rule above). ALWAYS assert exactly what the source labels, even when the label conflicts with the item’s ingredient information — never demote or drop a label because of ingredients, except when the item itself offers a matching "make it X" option (see optional_tags).',
	'- optional_tags are designations that hold only on request (e.g. "can be made vegan"). A tag never appears in both tags and optional_tags. When the source offers an item as "can be made X" / "make it X" (a modifier or note), X goes in optional_tags, NOT tags — the source resolves its own contradiction there, so no warning is needed. When an item shows BOTH a dietary label X AND a matching "make it X" / "can be made X" option, the on-request signal wins: X goes in optional_tags, NOT tags. This source-internal contradiction is different from an ingredient conflict — an ingredient conflict never demotes a label and gets a `warning` instead.',
	'- When a source label OBVIOUSLY conflicts with the item’s own listed ingredients (e.g. a "Vegan" label on an item whose description lists paneer/dairy), keep the tag AND set `warning` to a terse string noting the conflict; otherwise omit warning (or set it null).',
	'- description is the venue’s own menu text for the item, verbatim; if the source gives none, use null. Do not write your own descriptions.',
	'- price is a number (in the source’s currency) or null when the source shows no price.',
	'- A named listing shown at a rotating or market price ("Rotating Taps", "Rotating Canned Kombucha", "Market Price", "ask your server") IS a menu item: submit it with its displayed name and price null — do not invent or guess a price. (A heading that carries no item name of its own is not an item.)',
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
	/** Prompt tokens served from a provider cache (0 when none reported). */
	cachedPromptTokens: number;
	/** Tokens written INTO a provider cache (0 when none reported). */
	cacheWriteTokens: number;
	/** Provider-reported cost in USD, when surfaced (Claude backend). */
	totalCostUsd?: number;
	/**
	 * The raw per-request usage sequence, in request order, as the loop saw it —
	 * source for the openrouter run-cost accounting (real cost + cached-price
	 * counterfactual). Optional so the Claude backend need not populate it.
	 */
	usages?: ChatUsage[];
	/**
	 * Distinct upstream providers OpenRouter routed to, in first-seen order.
	 * Empty when the backend reports none (the Claude backend never does).
	 * More than one entry means the run was re-routed mid-flight.
	 */
	providers?: string[];
}

/**
 * Make an assistant turn safe to send back in the next request.
 *
 * A model can return a turn with NEITHER `content` nor `tool_calls` — typically
 * a reasoning-only turn, where the visible content is null. Echoing that
 * verbatim is invalid under the OpenAI schema ("content or tool_calls must be
 * set"), but providers disagree on enforcement: DeepInfra accepts it, GMICloud
 * rejects the whole request with a 400. That made the harness's behaviour depend
 * on which endpoint OpenRouter happened to route to.
 *
 * Normalizing the null to an empty string keeps the turn schema-valid on every
 * provider and changes nothing semantically — an empty assistant turn carries no
 * content either way. The TRANSCRIPT still records the original message verbatim,
 * so what the model actually returned is never lost.
 */
export function normalizeAssistantMessage(message: ChatMessage): ChatMessage {
	const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
	const hasContent = typeof message.content === 'string' && message.content.length > 0;
	if (hasToolCalls || hasContent) return message;
	return { ...message, content: '' };
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
	let cachedPromptTokens = 0;
	let cacheWriteTokens = 0;
	let nudged = false;
	const usages: ChatUsage[] = [];
	/** Distinct upstream providers seen, in first-seen order. */
	const providers: string[] = [];

	const done = (
		r: Omit<
			RunResult,
			| 'toolCalls'
			| 'submitAttempts'
			| 'promptTokens'
			| 'completionTokens'
			| 'totalTokens'
			| 'cachedPromptTokens'
			| 'cacheWriteTokens'
			| 'usages'
			| 'providers'
		>
	): RunResult => ({
		...r,
		toolCalls,
		submitAttempts,
		promptTokens,
		completionTokens,
		totalTokens,
		cachedPromptTokens,
		cacheWriteTokens,
		usages,
		providers
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
		usages.push(usage);
		promptTokens += usage.prompt_tokens ?? 0;
		completionTokens += usage.completion_tokens ?? 0;
		totalTokens += usage.total_tokens ?? 0;
		const cacheTokens = readCacheTokens(usage);
		cachedPromptTokens += cacheTokens.cached;
		cacheWriteTokens += cacheTokens.write;
		const message = response.choices[0]?.message;
		if (response.provider !== undefined && !providers.includes(response.provider)) {
			providers.push(response.provider);
		}
		transcript.push({
			type: 'response',
			ts: new Date().toISOString(),
			usage,
			// Recorded per request, not just per run: OpenRouter can re-route
			// mid-run, so a run is not guaranteed to be one provider throughout.
			provider: response.provider ?? null,
			response_id: response.id ?? null,
			message: message ?? null
		});
		if (!message) {
			return done({ status: 'failed', failureReason: 'model returned no message' });
		}
		messages.push(normalizeAssistantMessage(message));

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
					// Deterministic tail cleanup of leaked list-delimiter junk on
					// descriptions only — no snapshot/gold data consulted; the model's
					// tool result and the raw transcript submission are left untouched.
					applySubmitSanitation(submission.candidate);
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

/** Optional reasoning/sampling knobs applied to an OpenRouter request. */
export interface OpenRouterRequestOpts {
	/** OpenRouter unified reasoning effort — omitted (provider default) when unset. */
	effort?: string;
	/** Top-level sampling temperature — omitted when unset. */
	temperature?: number;
	/**
	 * Restrict routing to endpoints at these quantizations (OpenRouter
	 * `provider.quantizations`). Omitted = OpenRouter's default routing, which is
	 * cheapest-first and therefore biased toward the MOST quantized endpoint.
	 */
	quantizations?: string[];
}

/**
 * Build the OpenRouter chat request body (pure — no network). Anthropic-routed
 * models get prompt-cache breakpoints; other providers cache implicitly by
 * prefix, so their requests stay byte-identical (no cache_control). `effort`
 * (when set) rides OpenRouter's top-level unified reasoning parameter
 * (`reasoning: { effort }`); `temperature` (when set) is passed through top-level
 * and NOT gated per model — the provider rejects it where unsupported (e.g.
 * Sonnet 5 400s), and that upstream error is surfaced by the caller.
 */
export function buildOpenRouterBody(
	model: string,
	messages: ChatMessage[],
	opts: OpenRouterRequestOpts = {}
): Record<string, unknown> {
	const isAnthropic = model.startsWith('anthropic/');
	const body: Record<string, unknown> = {
		model,
		messages: isAnthropic ? withAnthropicCache(messages) : messages,
		tools: TOOLS,
		tool_choice: 'auto',
		usage: { include: true }
	};
	if (opts.effort !== undefined) body.reasoning = { effort: opts.effort };
	if (opts.temperature !== undefined) body.temperature = opts.temperature;
	// Pin routing to a quantization tier. allow_fallbacks:false is deliberate —
	// a silent fallback to a different tier would reintroduce exactly the
	// confound the pin exists to remove; better to fail the request loudly.
	if (opts.quantizations !== undefined && opts.quantizations.length > 0) {
		body.provider = { quantizations: opts.quantizations, allow_fallbacks: false };
	}
	return body;
}

/** Real model driver: POST to OpenRouter, retrying 429/5xx with backoff. */
export function openRouterChat(
	model: string,
	apiKey: string,
	opts: OpenRouterRequestOpts = {}
): ChatFn {
	return async (messages: ChatMessage[]): Promise<ChatResponse> => {
		const body = JSON.stringify(buildOpenRouterBody(model, messages, opts));
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

export type Backend = 'openrouter' | 'claude';

export interface RunMeta {
	model: string;
	backend: Backend;
	task_dir: string;
	entry_url: string;
	/** Requested reasoning-effort level, or null when unset (backend default applied). */
	effort: string | null;
	/**
	 * Short factual note of the default that applied when `effort` is null:
	 * `provider-default` (openrouter) or `claude-code-default` (claude). Always
	 * present so every run documents its reasoning depth. See the README for what
	 * those defaults resolve to (Anthropic API: high adaptive; Claude Code: xhigh).
	 */
	effort_default: string;
	/** Requested sampling temperature, or null when unset. */
	temperature: number | null;
	/**
	 * Quantization tiers routing was PINNED to (`--quantization`), or null for
	 * OpenRouter's default routing — which is cheapest-first and therefore biased
	 * toward the most-quantized endpoint. Null does NOT mean "unquantized".
	 */
	quantization_requested: string[] | null;
	/**
	 * Upstream providers that ACTUALLY served this run, in first-seen order.
	 * More than one entry means OpenRouter re-routed mid-run. Empty on the Claude
	 * backend, and on any run whose provider the API did not report.
	 */
	providers: string[];
	/**
	 * `providers` resolved to their quantization tiers, from OpenRouter's
	 * endpoints list at run time (e.g. `{"DeepInfra":"fp4"}`). Empty when the
	 * lookup failed — absence is a lookup gap, never evidence of no quantization.
	 */
	provider_quantizations: Record<string, string>;
	policy_version: string;
	started_at: string;
	/**
	 * Wall-clock of the AGENT RUN itself: from just before the first model request
	 * to just after scoring. Excludes CLI setup (manifest/gold load, the one-off
	 * OpenRouter models fetch), so it is the number to compare across models.
	 */
	duration_ms: number;
	/**
	 * TOTAL wall-clock of the whole `bench:run` invocation, from process start to
	 * the completed meta — setup, the agent run, and scoring. Always >=
	 * `duration_ms`; the gap is bench overhead, not model time.
	 */
	wall_clock_ms: number;
	/** ISO timestamp of process start — the origin `wall_clock_ms` is measured from. */
	invoked_at: string;
	tool_calls: number;
	submit_attempts: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** Prompt tokens served from a provider cache (0 when the provider reports none). */
	cached_prompt_tokens: number;
	/** Tokens written into a provider cache (0 when the provider reports none). */
	cache_write_tokens: number;
	/** Provider-reported cost in USD, when surfaced (Claude backend). */
	total_cost_usd?: number;
	/**
	 * REAL billed cost of the run in USD (openrouter backend only): the sum of
	 * per-request `usage.cost` values. Null when no request carried cost info.
	 * Absent (undefined) on the Claude backend, which reports `total_cost_usd`.
	 */
	price?: number | null;
	/**
	 * HYPOTHETICAL cost of the run in USD under PERFECT prefix caching (openrouter
	 * backend only) — see `estimateCachedPrice`. Null when model pricing could not
	 * be fetched. Absent (undefined) on the Claude backend.
	 */
	price_cached?: number | null;
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

export interface CliArgs {
	taskDir: string;
	model: string;
	maxToolCalls: number;
	backend: Backend;
	/** Reasoning-effort level, validated against the backend's set; undefined = backend default. */
	effort?: string;
	/** Sampling temperature (openrouter only); undefined = provider default. */
	temperature?: number;
	/** Run a blacklisted model/config anyway (deliberate re-test). */
	ignoreBlacklist?: boolean;
	/** Pin routing to these quantization tiers (openrouter only); undefined = default routing. */
	quantizations?: string[];
}

const USAGE =
	'usage: bun run bench:run <task-dir> --model <model-id> ' +
	'[--backend openrouter|claude] [--effort <level>] [--temperature <n>] [--max-tool-calls N] ' +
	'[--quantization <fp8[,bf16]>] [--ignore-blacklist]';

/** Only the OpenRouter backend needs OPENROUTER_API_KEY; Claude uses the SDK login. */
export function requiresOpenRouterKey(backend: Backend): boolean {
	return backend === 'openrouter';
}

export function parseCli(argv: string[]): CliArgs | { error: string } {
	let taskDir: string | undefined;
	let model: string | undefined;
	let maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
	let backend: Backend = 'openrouter';
	// Raw --effort/--temperature are captured here and validated AFTER the loop,
	// since --backend may appear either before or after them on the command line.
	let effortRaw: string | undefined;
	let temperature: number | undefined;
	let ignoreBlacklist = false;
	let quantizations: string[] | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--model') {
			model = argv[++i];
		} else if (arg === '--backend') {
			const b = argv[++i];
			if (b !== 'openrouter' && b !== 'claude') {
				return { error: `unknown backend: ${String(b)} (expected openrouter|claude)` };
			}
			backend = b;
		} else if (arg === '--effort') {
			effortRaw = argv[++i];
			if (effortRaw === undefined) return { error: '--effort requires a level' };
		} else if (arg === '--temperature') {
			const raw = argv[++i];
			const n = Number(raw);
			if (raw === undefined || raw === '' || !Number.isFinite(n))
				return { error: `--temperature must be a finite number (got ${String(raw)})` };
			temperature = n;
		} else if (arg === '--max-tool-calls') {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0)
				return { error: '--max-tool-calls must be a positive integer' };
			maxToolCalls = n;
		} else if (arg === '--quantization') {
			const raw = argv[++i];
			if (raw === undefined || raw === '') return { error: '--quantization requires a value' };
			const levels = raw.split(',').map((s) => s.trim());
			const bad = levels.find((l) => !(QUANTIZATION_LEVELS as readonly string[]).includes(l));
			if (bad !== undefined) {
				return {
					error: `--quantization must be one of ${QUANTIZATION_LEVELS.join('|')} (got ${bad})`
				};
			}
			quantizations = levels;
		} else if (arg === '--ignore-blacklist') {
			ignoreBlacklist = true;
		} else if (arg.startsWith('--')) {
			return { error: `unknown option: ${arg}` };
		} else if (taskDir === undefined) {
			taskDir = arg;
		} else {
			return { error: `unexpected argument: ${arg}` };
		}
	}
	if (!taskDir) return { error: 'missing <task-dir>' };
	if (!model) return { error: 'missing --model <model-id>' };

	// Provider routing is an OpenRouter concept; the Agent SDK has no equivalent.
	if (quantizations !== undefined && backend === 'claude') {
		return {
			error: '--quantization is not supported with --backend claude (no provider routing)'
		};
	}

	// The Claude backend exposes no sampling control, and current Claude models
	// (Sonnet 5 / Opus 4.7+) reject temperature/top_p outright — reject it here.
	if (temperature !== undefined && backend === 'claude')
		return {
			error:
				'--temperature is not supported with --backend claude (the SDK exposes no sampling control and current Claude models reject it)'
		};

	let effort: string | undefined;
	if (effortRaw !== undefined) {
		const levels = effortLevelsFor(backend);
		if (!levels.includes(effortRaw))
			return {
				error: `--effort must be one of ${levels.join('|')} for the ${backend} backend (got ${effortRaw})`
			};
		effort = effortRaw;
	}

	return {
		taskDir,
		model,
		maxToolCalls,
		backend,
		effort,
		temperature,
		ignoreBlacklist,
		quantizations
	};
}

/** Assemble a RunMeta from a completed (or fatally-failed) run. */
export function buildMeta(
	cli: CliArgs,
	manifest: BenchManifest,
	policyVersion: string,
	startedAt: Date,
	result: RunResult,
	costs?: { price: number | null; price_cached: number | null },
	/** Process-start instant; defaults to `startedAt` so a run with no setup phase reads equal. */
	invokedAt: Date = startedAt,
	/** provider → quantization, resolved after the run; empty when unavailable. */
	providerQuantizations: Record<string, string> = {}
): RunMeta {
	const providers = result.providers ?? [];
	return {
		model: cli.model,
		backend: cli.backend,
		task_dir: cli.taskDir,
		entry_url: manifest.entryUrl,
		effort: cli.effort ?? null,
		effort_default: cli.backend === 'claude' ? 'claude-code-default' : 'provider-default',
		temperature: cli.temperature ?? null,
		quantization_requested: cli.quantizations ?? null,
		providers,
		// Only the providers this run actually used — not the whole endpoint table.
		provider_quantizations: Object.fromEntries(
			providers.filter((p) => p in providerQuantizations).map((p) => [p, providerQuantizations[p]])
		),
		policy_version: policyVersion,
		started_at: startedAt.toISOString(),
		duration_ms: Date.now() - startedAt.getTime(),
		wall_clock_ms: Date.now() - invokedAt.getTime(),
		invoked_at: invokedAt.toISOString(),
		tool_calls: result.toolCalls,
		submit_attempts: result.submitAttempts,
		prompt_tokens: result.promptTokens,
		completion_tokens: result.completionTokens,
		total_tokens: result.totalTokens,
		cached_prompt_tokens: result.cachedPromptTokens,
		cache_write_tokens: result.cacheWriteTokens,
		total_cost_usd: result.totalCostUsd,
		// price/price_cached are openrouter-only — left ABSENT (undefined) on the
		// Claude backend so its metas carry no null run-cost fields.
		...(costs ? { price: costs.price, price_cached: costs.price_cached } : {}),
		status: result.status,
		failure_reason: result.failureReason
	};
}

/**
 * Openrouter run-cost accounting for a completed (or partially-run) result:
 * `price` from the summed per-request `usage.cost`, `price_cached` from the
 * cached-price counterfactual using the pricing in the already-fetched
 * `modelInfo` (null when pricing is unavailable). Pure — model info is fetched
 * once per run by the caller and passed in. Returns undefined for any
 * non-openrouter backend so those metas omit the fields entirely.
 */
function computeOpenRouterCosts(
	cli: CliArgs,
	result: RunResult,
	modelInfo: ModelInfo | null
): { price: number | null; price_cached: number | null } | undefined {
	if (cli.backend !== 'openrouter') return undefined;
	const usages = result.usages ?? [];
	const price = sumRealCost(usages);
	const pricing = modelInfo?.pricing ?? null;
	const price_cached = pricing
		? estimateCachedPrice(
				usages.map((u) => ({
					promptTotal: u.prompt_tokens ?? 0,
					completion: u.completion_tokens ?? 0
				})),
				pricing
			)
		: null;
	return { price, price_cached };
}

/**
 * The stderr provenance line: who actually served the run and at what
 * quantization. Printed on every openrouter run — the quantization tier is part
 * of what was measured, so a score reported without it is unattributable.
 */
export function formatProvenance(meta: RunMeta): string | undefined {
	if (meta.providers.length === 0) return undefined;
	const parts = meta.providers.map((p) => {
		const q = meta.provider_quantizations[p];
		return q === undefined ? `${p} (quantization unknown)` : `${p} @ ${q}`;
	});
	const pin =
		meta.quantization_requested === null
			? ' [unpinned — OpenRouter default routing]'
			: ` [pinned: ${meta.quantization_requested.join(',')}]`;
	const reroute = meta.providers.length > 1 ? '  ** RE-ROUTED MID-RUN **' : '';
	return `served by  ${parts.join(', ')}${pin}${reroute}`;
}

/** The stderr wall-clock line: total invocation time, with the agent run broken out. */
export function formatWallClock(meta: Pick<RunMeta, 'wall_clock_ms' | 'duration_ms'>): string {
	return (
		`wall-clock ${formatDuration(meta.wall_clock_ms)} total ` +
		`(${formatDuration(meta.duration_ms)} in the agent run)`
	);
}

/** `1m 04s` / `12.3s` — wall-clock for humans. */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

async function main(): Promise<number> {
	// Origin for wall_clock_ms — taken before ANY work so setup counts too.
	const invokedAt = new Date();
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(USAGE);
		return 2;
	}

	// Blacklist FIRST: a configuration already ruled out must cost nothing — no
	// key check, no models fetch, no chat request. Exit 3 (not 2) so a sweep can
	// tell "deliberately skipped" from "misconfigured" and keep going.
	let blocked: BlacklistEntry | undefined;
	try {
		blocked = findBlock(loadBlacklist(), {
			model: cli.model,
			effort: cli.effort,
			backend: cli.backend
		});
	} catch (e) {
		console.error(`error: ${String(e)}`);
		return 2;
	}
	if (blocked && !cli.ignoreBlacklist) {
		console.error(formatBlocked(blocked, '--ignore-blacklist'));
		return 3;
	}
	if (blocked) {
		console.error(
			`note: ${describeEntry(blocked)} is blacklisted — running anyway per --ignore-blacklist`
		);
	}

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (requiresOpenRouterKey(cli.backend) && !apiKey) {
		console.error('error: OPENROUTER_API_KEY is not set (required for the openrouter backend)');
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

	// Fetch the model's OpenRouter metadata ONCE (pricing + supported_parameters)
	// and share it between pre-flight parameter validation (below) and the run-cost
	// accounting (after the run). Only the openrouter backend uses the endpoint.
	const modelInfo = cli.backend === 'openrouter' ? await fetchModelInfo(cli.model) : null;

	// Pre-flight: reject an --effort/--temperature the model does not accept BEFORE
	// burning a chat request. A missing/unfetchable allowlist NEVER blocks the run —
	// it warns and proceeds (the provider is the source of truth, this is a courtesy).
	if (cli.backend === 'openrouter' && (cli.effort !== undefined || cli.temperature !== undefined)) {
		const supported = modelInfo?.supportedParameters ?? null;
		if (supported === null) {
			console.error(
				`note: could not read supported_parameters for ${cli.model} — skipping pre-flight --effort/--temperature validation`
			);
		} else {
			const err = validateRequestedParams(
				{ effort: cli.effort, temperature: cli.temperature },
				supported
			);
			if (err) {
				console.error(`error: model ${cli.model} ${err}`);
				return 2;
			}
		}
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
		if (cli.backend === 'claude') {
			// Loaded lazily so the openrouter path never imports the Agent SDK.
			const { runClaudeAgent } = await import('./run-claude');
			result = await runClaudeAgent({
				model: cli.model,
				store,
				entryUrl: manifest.entryUrl,
				maxToolCalls: cli.maxToolCalls,
				// Validated against CLAUDE_EFFORT_LEVELS in parseCli, so this narrows safely.
				effort: cli.effort as EffortLevel | undefined,
				transcript
			});
		} else {
			result = await runAgent({
				chat: openRouterChat(cli.model, apiKey ?? '', {
					effort: cli.effort,
					temperature: cli.temperature,
					quantizations: cli.quantizations
				}),
				store,
				entryUrl: manifest.entryUrl,
				maxToolCalls: cli.maxToolCalls,
				transcript
			});
		}
	} catch (e) {
		const failed: RunResult = {
			status: 'failed',
			failureReason: String(e),
			toolCalls: 0,
			submitAttempts: 0,
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedPromptTokens: 0,
			cacheWriteTokens: 0,
			usages: []
		};
		// A thrown run collected no usage, so price is null; keep the openrouter
		// fields present (as null) rather than fetching pricing for an empty run.
		const costs = cli.backend === 'openrouter' ? { price: null, price_cached: null } : undefined;
		const meta = buildMeta(cli, manifest, gold.policy_version, startedAt, failed, costs, invokedAt);
		writeRun(runDir, { meta, transcript });
		console.error(`run failed: ${String(e)}`);
		console.error(formatWallClock(meta));
		console.error(`run directory: ${runDir}`);
		return 1;
	}

	const report = result.candidate ? scoreCandidate(gold, result.candidate) : undefined;
	const costs = computeOpenRouterCosts(cli, result, modelInfo);
	// Resolve the providers this run used to their quantization tiers. Only worth
	// a request when the run actually reported providers; best-effort throughout.
	const providerQuants =
		cli.backend === 'openrouter' && (result.providers?.length ?? 0) > 0
			? await fetchProviderQuantizations(cli.model)
			: {};
	const meta = buildMeta(
		cli,
		manifest,
		gold.policy_version,
		startedAt,
		result,
		costs,
		invokedAt,
		providerQuants
	);
	writeRun(runDir, { meta, transcript, candidate: result.candidate, report });

	if (report) console.error(formatSummary(report));
	else console.error(`run failed: ${result.failureReason ?? 'unknown'}`);
	const provenance = formatProvenance(meta);
	if (provenance) console.error(provenance);
	console.error(formatWallClock(meta));
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
