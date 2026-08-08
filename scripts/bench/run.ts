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
import {
	DEFAULT_HARNESS,
	HARNESS_NAMES,
	harnessFor,
	mergePassResults,
	promptShasFor,
	promptTextsFor,
	reviewLabel,
	userMessageFor,
	type HarnessSpec,
	type PassMeta,
	type PassSpec
} from './harness';
import { DIETARY_TAGS, GoldSchema, htmlToText, nameMatchKey, type GoldMenu } from './lint';
import { SYSTEM_PROMPT } from './prompts';
import {
	CandidateSchema,
	formatSummary,
	scoreCandidate,
	type CandidateMenu,
	type ScoreReport
} from './score';
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

// --- submit_corrections (patch passes) -----------------------------------------

/**
 * Structural shape of a submit_corrections payload. Deliberately loose on item
 * fields: the patched RESULT is validated against the scorer's CandidateSchema,
 * which stays the single source of truth for what an item is — a second,
 * hand-mirrored item schema here would drift from it.
 */
const CorrectionsSchema = v.strictObject({
	add: v.optional(v.array(v.looseObject({}))),
	remove: v.optional(v.array(v.string())),
	update: v.optional(v.array(v.strictObject({ name: v.string(), set: v.looseObject({}) }))),
	set_sources: v.optional(v.array(v.string())),
	/**
	 * Whole-venue dietary sweep: add these tags to EVERY item (added items
	 * included). Exists because the venue-wide designation rule is a menu-wide
	 * fact, and expressing it as ~180 per-item update ops measurably under-applies
	 * — a patch reviewer swept only half a plant-based menu that way.
	 */
	tag_menu: v.optional(v.array(v.picklist(DIETARY_TAGS)))
});

const UPDATABLE_FIELDS = new Set([
	'name',
	'description',
	'tags',
	'optional_tags',
	'price',
	'warning'
]);

/**
 * Validate a submit_corrections payload and apply it to the previous pass's
 * candidate. Returns the same SubmitResult shape as validateSubmission, so the
 * agent loop's retry machinery treats both submission modes identically.
 *
 * `remove` and `update` name draft items by the scorer's own identity —
 * `nameMatchKey` — so trivial paren/spacing differences in how the model quotes
 * a name back never fail a legitimate correction. A name matching NO draft item
 * is an issue (the model is correcting something that is not there), as is one
 * matching two (ambiguous target). The patched result must pass CandidateSchema;
 * every issue is reported against the operation that caused it where possible.
 */
export function applyCorrections(
	previous: v.InferOutput<typeof CandidateSchema>,
	payload: unknown
): SubmitResult {
	const parsed = v.safeParse(CorrectionsSchema, payload);
	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.issues
				.slice(0, 20)
				.map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
		};
	}
	const ops = parsed.output;
	const issues: string[] = [];

	// Work on a deep copy — the previous candidate is pass 1's recorded output
	// and must never be mutated by a failed (or successful) patch attempt.
	const result = structuredClone(previous) as {
		sources: string[];
		items: Record<string, unknown>[];
	};

	const findByName = (name: string): number[] => {
		const key = nameMatchKey(name);
		const hits: number[] = [];
		for (let i = 0; i < result.items.length; i += 1) {
			if (nameMatchKey(String(result.items[i].name)) === key) hits.push(i);
		}
		return hits;
	};

	for (const op of ops.update ?? []) {
		const unknownFields = Object.keys(op.set).filter((k) => !UPDATABLE_FIELDS.has(k));
		if (unknownFields.length > 0) {
			issues.push(`update "${op.name}": unknown field(s) ${unknownFields.join(', ')}`);
			continue;
		}
		const hits = findByName(op.name);
		if (hits.length === 0) issues.push(`update "${op.name}": no draft item has that name`);
		else if (hits.length > 1) issues.push(`update "${op.name}": matches more than one draft item`);
		else Object.assign(result.items[hits[0]], op.set);
	}

	for (const name of ops.remove ?? []) {
		const hits = findByName(name);
		if (hits.length === 0) issues.push(`remove "${name}": no draft item has that name`);
		else if (hits.length > 1) issues.push(`remove "${name}": matches more than one draft item`);
		else result.items.splice(hits[0], 1);
	}

	for (const item of ops.add ?? []) {
		result.items.push(item as Record<string, unknown>);
	}

	if (ops.set_sources !== undefined) result.sources = ops.set_sources;

	// After add/update, so a sweep covers every item that ends up on the menu.
	for (const tag of ops.tag_menu ?? []) {
		for (const item of result.items) {
			const tags = Array.isArray(item.tags) ? (item.tags as unknown[]) : [];
			if (!tags.includes(tag)) item.tags = [...tags, tag];
		}
	}

	if (issues.length > 0) return { ok: false, issues: issues.slice(0, 20) };

	// Added/renamed items must not collide with kept ones under the scorer's
	// identity — a duplicate would silently score as a hallucination.
	const seen = new Map<string, string>();
	for (const item of result.items) {
		const key = nameMatchKey(String(item.name));
		const prior = seen.get(key);
		if (prior !== undefined) {
			issues.push(`duplicate item name after corrections: "${prior}" vs "${String(item.name)}"`);
		} else {
			seen.set(key, String(item.name));
		}
	}
	if (issues.length > 0) return { ok: false, issues: issues.slice(0, 20) };

	return validateSubmission(result);
}

// --- tool definitions sent to the model --------------------------------------

const FETCH_PAGE_TOOL = {
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
};

/** JSON-schema for one menu item, shared by submit_menu and submit_corrections. */
const ITEM_SCHEMA = {
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
};

const TOOLS = [
	FETCH_PAGE_TOOL,
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
						items: ITEM_SCHEMA
					}
				},
				required: ['sources', 'items']
			}
		}
	}
];

/**
 * The patch-pass tool set: fetch_page plus submit_corrections instead of
 * submit_menu. Operations are applied to the previous pass's candidate — the
 * reviewer never re-emits the full menu.
 */
export const PATCH_TOOLS = [
	FETCH_PAGE_TOOL,
	{
		type: 'function',
		function: {
			name: 'submit_corrections',
			description:
				'Submit your corrections to the draft menu as operations. Call this exactly once when done. ' +
				'An empty object approves the draft unchanged.',
			parameters: {
				type: 'object',
				properties: {
					add: {
						type: 'array',
						items: ITEM_SCHEMA,
						description: 'Items the draft missed, complete with all fields.'
					},
					remove: {
						type: 'array',
						items: { type: 'string' },
						description: 'Names of draft items the source does not itemize, exactly as drafted.'
					},
					update: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'The draft item’s current name.' },
								set: {
									type: 'object',
									description:
										'Only the fields to change: name (to rename), description, tags, optional_tags, price, warning.',
									properties: ITEM_SCHEMA.properties
								}
							},
							required: ['name', 'set']
						},
						description: 'Field-level fixes to draft items.'
					},
					set_sources: {
						type: 'array',
						items: { type: 'string' },
						description: 'Replace the draft’s sources list entirely. Omit to keep it.'
					},
					tag_menu: {
						type: 'array',
						items: { type: 'string', enum: [...DIETARY_TAGS] },
						description:
							'Whole-venue dietary sweep: add these dietary tags to EVERY item on the menu (including ones you add). Use when the source designates a claim venue-wide (e.g. a plant-based venue → ["vegan"]), instead of one update per item.'
					}
				}
			}
		}
	}
];

// The extraction prompt now lives in ./prompts alongside the review prompt that
// composes with it, and alongside `promptSha`. Re-exported here because this is
// where run-claude.ts and the existing tests already reach for it.
export { SYSTEM_PROMPT };

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

	// PROJECTED onto the request schema, not spread. A provider's response carries
	// fields that belong only to a response — `reasoning`, `reasoning_details`,
	// `refusal` — and echoing them into the next request is a deserialization
	// hazard, the same class of provider disagreement as the empty-turn case above.
	// CoreWeave maps BOTH `reasoning` and `reasoning_details` onto one
	// `reasoning_content` field and rejects the whole request with
	// "duplicate field `reasoning_content`", intermittently, once a conversation
	// has accumulated the right combination of turns; GMICloud and DeepInfra
	// tolerate them, so which endpoint OpenRouter happened to route to decided
	// whether a run completed. They also carry nothing the model needs — a model's
	// own reasoning is not an input — so dropping them loses no signal.
	//
	// `tool_calls` is copied whenever the KEY is present, empty array included: an
	// empty `tool_calls: []` is a turn the model really sent that way, and the
	// transcript should not disagree with what was echoed.
	const normalized: ChatMessage = { role: message.role };
	if (message.tool_calls !== undefined) normalized.tool_calls = message.tool_calls;
	if (message.tool_call_id !== undefined) normalized.tool_call_id = message.tool_call_id;
	if (hasToolCalls || hasContent) {
		if (message.content !== undefined) normalized.content = message.content;
	} else {
		normalized.content = '';
	}
	return normalized;
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
	/** System prompt for this pass; defaults to the extraction prompt. */
	systemPrompt?: string;
	/** Opening user message; defaults to just handing over the entry URL. */
	userMessage?: string;
	/**
	 * When set, this is a PATCH pass: the model gets submit_corrections instead
	 * of submit_menu, and its operations are applied to this candidate to produce
	 * the pass's result. The caller must also send `PATCH_TOOLS` on the chat
	 * request (see `OpenRouterRequestOpts.tools`).
	 */
	patchPrevious?: CandidateMenu;
}): Promise<RunResult> {
	const { chat, store, entryUrl, maxToolCalls, transcript, patchPrevious } = opts;
	const submitToolName = patchPrevious ? 'submit_corrections' : 'submit_menu';
	const messages: ChatMessage[] = [
		{ role: 'system', content: opts.systemPrompt ?? SYSTEM_PROMPT },
		{
			role: 'user',
			content: opts.userMessage ?? `The restaurant’s website entry URL is: ${entryUrl}`
		}
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
					content: patchPrevious
						? 'You must call submit_corrections with your corrections (an empty object approves the draft unchanged).'
						: 'You must call submit_menu with your final extraction.'
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
			} else if (call.function.name === submitToolName) {
				submitAttempts += 1;
				const submission = patchPrevious
					? applyCorrections(patchPrevious, parsed.value)
					: validateSubmission(parsed.value);
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
						failureReason: `${submitToolName} failed validation ${MAX_SUBMIT_ATTEMPTS} times`
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
	/**
	 * Restrict routing to exactly these providers (OpenRouter `provider.only`),
	 * with fallbacks off — a silent fallback to another provider would
	 * reintroduce the confound the pin removes. Omitted = any provider.
	 */
	providerOnly?: string[];
	/** Tool set to offer the model; defaults to the extraction tools (`TOOLS`). */
	tools?: unknown[];
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
		tools: opts.tools ?? TOOLS,
		tool_choice: 'auto',
		usage: { include: true }
	};
	if (opts.effort !== undefined) body.reasoning = { effort: opts.effort };
	if (opts.temperature !== undefined) body.temperature = opts.temperature;
	// Pin routing to a quantization tier. allow_fallbacks:false is deliberate —
	// a silent fallback to a different tier would reintroduce exactly the
	// confound the pin exists to remove; better to fail the request loudly.
	const provider: Record<string, unknown> = {};
	if (opts.quantizations !== undefined && opts.quantizations.length > 0) {
		provider.quantizations = opts.quantizations;
	}
	if (opts.providerOnly !== undefined && opts.providerOnly.length > 0) {
		provider.only = opts.providerOnly;
	}
	if (Object.keys(provider).length > 0) {
		body.provider = { ...provider, allow_fallbacks: false };
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
	/**
	 * The agent setup this run was driven by (see harness.ts). Always written.
	 * A run predating the field is `single-pass` by construction — that was the
	 * only setup that existed — and the analysis layer defaults it accordingly.
	 */
	harness: string;
	/**
	 * Content hash of each pass's system prompt, keyed `<index>-<role>`. Prompt
	 * text is part of what a score measures: two runs sharing a model, provider
	 * and effort but not a prompt are different configurations. Runs predating
	 * this field record no hash and are treated as an UNKNOWN prompt, never as
	 * one matching today's.
	 */
	prompt_sha: Record<string, string>;
	/**
	 * Model used for the review pass. Null when the harness has no review pass,
	 * or when the review pass inherited `model` (the self-correction setup).
	 */
	review_model: string | null;
	/** Reasoning effort for the review pass; null when unset or inherited. */
	review_effort: string | null;
	/**
	 * Per-pass configuration and outcome. Single-element for `single-pass`. The
	 * top-level token/cost/timing fields are the run TOTALS across these.
	 */
	passes: PassMeta[];
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
	/** Providers routing was pinned to (`--provider`), or null when unpinned. */
	provider_requested: string[] | null;
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
		/**
		 * The FIRST pass's submission and its score, on a multi-pass harness. Kept
		 * beside the final result so a reviewer's effect is measurable: without it
		 * you can see that a two-pass run scored 94%, but not whether the second
		 * pass earned four points or gave away six. `candidate.json`/`report.json`
		 * remain the run's headline result, so every existing reader is unaffected.
		 */
		firstPassCandidate?: v.InferOutput<typeof CandidateSchema>;
		firstPassReport?: ScoreReport;
		/**
		 * The full prompt text behind each `prompt_sha`, keyed `<index>-<role>`.
		 * meta.json carries only the hashes; this makes them resolvable from the
		 * run directory itself instead of from git archaeology.
		 */
		prompts?: Record<string, { sha: string; text: string }>;
	}
): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, 'meta.json'), JSON.stringify(parts.meta, null, '\t'));
	if (parts.prompts) {
		writeFileSync(join(runDir, 'prompts.json'), JSON.stringify(parts.prompts, null, '\t'));
	}
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
	if (parts.firstPassCandidate) {
		writeFileSync(
			join(runDir, 'candidate-pass1.json'),
			JSON.stringify(parts.firstPassCandidate, null, '\t')
		);
	}
	if (parts.firstPassReport) {
		writeFileSync(
			join(runDir, 'report-pass1.json'),
			JSON.stringify(parts.firstPassReport, null, '\t')
		);
	}
}

/**
 * Reserve a unique run directory under `parent`, atomically. `mkdirSync`
 * WITHOUT `recursive` throws on an existing path, which is the collision
 * signal; on collision a `-2`, `-3`, … suffix is tried. Claiming up front —
 * rather than at writeRun time — closes the same-millisecond race two parallel
 * runs of one task hit in practice (both computed the same timestamp name and
 * the loser's evidence was silently overwritten).
 */
export function claimRunDir(parent: string, name: string): string {
	mkdirSync(parent, { recursive: true });
	for (let n = 1; ; n += 1) {
		const dir = join(parent, n === 1 ? name : `${name}-${n}`);
		try {
			mkdirSync(dir);
			return dir;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') throw e;
		}
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
	/** Pin routing to exactly these providers (openrouter only); undefined = any. */
	providerOnly?: string[];
	/** Agent setup driving the run (see harness.ts); defaults to `single-pass`. */
	harness: string;
	/**
	 * Model for the review pass. Undefined means "inherit the primary model", which
	 * is the self-correction configuration; setting it gives the drafter/reviewer
	 * split (a cheap extractor checked by a stronger reviewer).
	 */
	reviewModel?: string;
	/** Reasoning effort for the review pass; undefined inherits `effort`. */
	reviewEffort?: string;
}

const USAGE =
	'usage: bun run bench:run <task-dir> --model <model-id> ' +
	'[--backend openrouter|claude] [--effort <level>] [--temperature <n>] [--max-tool-calls N] ' +
	'[--quantization <fp8[,bf16]>] [--provider <name[,name]>] [--harness <name>] [--review-model <id>] ' +
	'[--review-effort <level>] [--ignore-blacklist]\n' +
	`  harnesses: ${HARNESS_NAMES.join(', ')}`;

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
	let providerOnly: string[] | undefined;
	let harness = DEFAULT_HARNESS;
	let reviewModel: string | undefined;
	// Validated after the loop for the same reason as --effort: --backend may
	// appear on either side of it.
	let reviewEffortRaw: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--model') {
			model = argv[++i];
		} else if (arg === '--harness') {
			const h = argv[++i];
			if (h === undefined || h === '') return { error: '--harness requires a name' };
			if (!HARNESS_NAMES.includes(h)) {
				return { error: `unknown harness: ${h} (expected ${HARNESS_NAMES.join('|')})` };
			}
			harness = h;
		} else if (arg === '--review-model') {
			reviewModel = argv[++i];
			if (reviewModel === undefined || reviewModel === '')
				return { error: '--review-model requires a model id' };
		} else if (arg === '--review-effort') {
			reviewEffortRaw = argv[++i];
			if (reviewEffortRaw === undefined) return { error: '--review-effort requires a level' };
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
		} else if (arg === '--provider') {
			const raw = argv[++i];
			if (raw === undefined || raw === '') return { error: '--provider requires a name' };
			providerOnly = raw
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s !== '');
			if (providerOnly.length === 0) return { error: '--provider requires a name' };
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
	if (providerOnly !== undefined && backend === 'claude') {
		return { error: '--provider is not supported with --backend claude (no provider routing)' };
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

	let reviewEffort: string | undefined;
	if (reviewEffortRaw !== undefined) {
		const levels = effortLevelsFor(backend);
		if (!levels.includes(reviewEffortRaw))
			return {
				error: `--review-effort must be one of ${levels.join('|')} for the ${backend} backend (got ${reviewEffortRaw})`
			};
		reviewEffort = reviewEffortRaw;
	}

	// A review override on a harness with no review pass is silently ignorable,
	// but silence is how someone spends a sweep believing they tested a reviewer
	// they never ran. Reject it instead.
	const spec = harnessFor(harness);
	const hasReviewPass = spec?.passes.some((p) => p.role === 'review') ?? false;
	if (!hasReviewPass && (reviewModel !== undefined || reviewEffort !== undefined)) {
		const flag = reviewModel !== undefined ? '--review-model' : '--review-effort';
		return {
			error: `${flag} requires a harness with a review pass (--harness ${harness} has none)`
		};
	}

	// The Agent SDK path serves a fixed submit_menu tool; a patch pass needs
	// submit_corrections, so running it there would measure a different setup
	// than the harness names. Reject up front rather than after pass 1 has spent.
	if (backend === 'claude' && (spec?.passes.some((p) => p.submission === 'patch') ?? false)) {
		return {
			error: `--harness ${harness} is not supported with --backend claude (patch passes need the submit_corrections tool, which the Agent SDK path does not serve)`
		};
	}

	return {
		taskDir,
		model,
		maxToolCalls,
		backend,
		effort,
		temperature,
		ignoreBlacklist,
		quantizations,
		providerOnly,
		harness,
		reviewModel,
		reviewEffort
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
	providerQuantizations: Record<string, string> = {},
	/** Per-pass breakdown; defaults to empty for callers that ran no pass at all. */
	passes: PassMeta[] = []
): RunMeta {
	const providers = result.providers ?? [];
	const spec = harnessFor(cli.harness);
	return {
		model: cli.model,
		backend: cli.backend,
		task_dir: cli.taskDir,
		entry_url: manifest.entryUrl,
		harness: cli.harness,
		prompt_sha: spec ? promptShasFor(spec) : {},
		review_model: cli.reviewModel ?? null,
		review_effort: cli.reviewEffort ?? null,
		passes,
		effort: cli.effort ?? null,
		effort_default: cli.backend === 'claude' ? 'claude-code-default' : 'provider-default',
		temperature: cli.temperature ?? null,
		quantization_requested: cli.quantizations ?? null,
		provider_requested: cli.providerOnly ?? null,
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

/** The model a pass runs under: a review pass may override, and otherwise inherits. */
export function modelForPass(cli: CliArgs, pass: PassSpec): string {
	return pass.role === 'review' ? (cli.reviewModel ?? cli.model) : cli.model;
}

/** The reasoning effort a pass runs under; same inheritance rule as the model. */
export function effortForPass(cli: CliArgs, pass: PassSpec): string | undefined {
	return pass.role === 'review' ? (cli.reviewEffort ?? cli.effort) : cli.effort;
}

/**
 * Run ONE pass of a harness, appending its events to the run transcript tagged
 * with which pass produced them.
 *
 * Each pass gets a fresh message list: a review pass is a NEW agent handed the
 * previous submission, not a continuation of the extractor's context. That is
 * the setup being measured — carrying the first pass's reasoning forward would
 * make it a longer single conversation instead.
 */
async function executePass(opts: {
	pass: PassSpec;
	cli: CliArgs;
	store: SnapshotStore;
	entryUrl: string;
	previous: CandidateMenu | undefined;
	transcript: TranscriptEvent[];
	apiKey: string;
}): Promise<RunResult> {
	const { pass, cli, store, entryUrl, previous, transcript, apiKey } = opts;
	const model = modelForPass(cli, pass);
	const effort = effortForPass(cli, pass);
	const userMessage = userMessageFor(pass, entryUrl, previous);
	// Collected separately so every event can be stamped with its pass, including
	// the ones already recorded when a pass throws midway.
	const passTranscript: TranscriptEvent[] = [];

	const drain = (): void => {
		for (const e of passTranscript) {
			transcript.push({ ...e, pass: pass.index, pass_role: pass.role });
		}
		passTranscript.length = 0;
	};

	const isPatch = pass.submission === 'patch';
	try {
		if (cli.backend === 'claude') {
			// parseCli rejects patch harnesses on this backend; guard against a
			// future harness slipping one through, because silently running the
			// pass with submit_menu would measure a different setup than named.
			if (isPatch) {
				throw new Error('patch passes are not supported on the claude backend');
			}
			const { runClaudeAgent } = await import('./run-claude');
			return await runClaudeAgent({
				model,
				store,
				entryUrl,
				maxToolCalls: cli.maxToolCalls,
				effort: effort as EffortLevel | undefined,
				transcript: passTranscript,
				systemPrompt: pass.systemPrompt,
				userPrompt: userMessage
			});
		}
		return await runAgent({
			chat: openRouterChat(model, apiKey, {
				effort,
				temperature: cli.temperature,
				quantizations: cli.quantizations,
				providerOnly: cli.providerOnly,
				tools: isPatch ? PATCH_TOOLS : undefined
			}),
			store,
			entryUrl,
			maxToolCalls: cli.maxToolCalls,
			transcript: passTranscript,
			systemPrompt: pass.systemPrompt,
			userMessage,
			patchPrevious: isPatch ? previous : undefined
		});
	} finally {
		drain();
	}
}

/**
 * Every distinct model the harness will actually call, in pass order.
 *
 * A `--review-model` split is two models in one run, and anything fetched
 * per-model (pricing, `supported_parameters`, provider quantization tiers) has to
 * cover both or it describes the wrong one.
 */
export function distinctPassModels(harness: HarnessSpec, cli: CliArgs): string[] {
	const out: string[] = [];
	for (const pass of harness.passes) {
		const model = modelForPass(cli, pass);
		if (!out.includes(model)) out.push(model);
	}
	return out;
}

/** How a single pass is executed; injectable so the sequencing is testable. */
export type PassExecutor = (opts: {
	pass: PassSpec;
	cli: CliArgs;
	store: SnapshotStore;
	entryUrl: string;
	previous: CandidateMenu | undefined;
	transcript: TranscriptEvent[];
	apiKey: string;
}) => Promise<RunResult>;

export interface PassSequence {
	passResults: RunResult[];
	passMetas: PassMeta[];
	/** Pass 1's submission, kept so a review pass's effect can be scored separately. */
	firstPassCandidate: CandidateMenu | undefined;
	/** Set when a pass threw; the caller writes the failed run and stops. */
	threw?: { pass: PassSpec; error: unknown };
}

/**
 * Drive a harness's passes in order, threading each submission into the next.
 *
 * Stops early — without an error — when a pass produces no candidate: a review
 * pass has nothing to review, and inventing a fallback would silently score a
 * different setup than the one requested. Stops with `threw` set when a pass
 * raises, so the caller can still write the partial run rather than losing the
 * transcript.
 *
 * Extracted from `main()` so the sequencing is testable without a network: pass
 * an `execute` and drive the whole harness with scripted results.
 */
export async function runPasses(opts: {
	harness: HarnessSpec;
	cli: CliArgs;
	store: SnapshotStore;
	entryUrl: string;
	transcript: TranscriptEvent[];
	apiKey: string;
	/**
	 * Pricing per MODEL, not per run: a `--review-model` split bills two models,
	 * and pricing pass 2's tokens at pass 1's rates under-reported the README's own
	 * flagship example (cheap drafter + strong reviewer) by ~16x on the Frontier's
	 * cost axis.
	 */
	modelInfo: (model: string) => ModelInfo | null;
	execute?: PassExecutor;
	onPassStart?: (pass: PassSpec) => void;
	onPassAbandoned?: (pass: PassSpec, reason: string) => void;
}): Promise<PassSequence> {
	const { harness, cli, store, entryUrl, transcript, apiKey, modelInfo } = opts;
	const execute = opts.execute ?? executePass;

	const passResults: RunResult[] = [];
	const passMetas: PassMeta[] = [];
	let firstPassCandidate: CandidateMenu | undefined;
	let previous: CandidateMenu | undefined;

	for (const pass of harness.passes) {
		opts.onPassStart?.(pass);
		const passStartedAt = Date.now();
		let result: RunResult;
		try {
			result = await execute({ pass, cli, store, entryUrl, previous, transcript, apiKey });
		} catch (error) {
			// A thrown pass collected no usage, so its price is null; the openrouter
			// fields stay PRESENT as null rather than absent — absent would read as
			// "this backend does not report cost", which is a different claim.
			const thrown: RunResult = {
				status: 'failed',
				failureReason: String(error),
				toolCalls: 0,
				submitAttempts: 0,
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedPromptTokens: 0,
				cacheWriteTokens: 0,
				usages: []
			};
			const thrownCosts =
				cli.backend === 'openrouter' ? { price: null, price_cached: null } : undefined;
			passResults.push(thrown);
			passMetas.push(toPassMeta(pass, cli, thrown, Date.now() - passStartedAt, thrownCosts));
			return { passResults, passMetas, firstPassCandidate, threw: { pass, error } };
		}

		passResults.push(result);
		passMetas.push(
			toPassMeta(
				pass,
				cli,
				result,
				Date.now() - passStartedAt,
				computeOpenRouterCosts(cli, result, modelInfo(modelForPass(cli, pass)))
			)
		);

		if (pass.index === 1) firstPassCandidate = result.candidate;

		if (!result.candidate) {
			opts.onPassAbandoned?.(pass, result.failureReason ?? 'unknown');
			break;
		}
		previous = result.candidate;
	}

	return { passResults, passMetas, firstPassCandidate };
}

/** Fold one pass's result and configuration into its `meta.passes` entry. */
function toPassMeta(
	pass: PassSpec,
	cli: CliArgs,
	result: RunResult,
	durationMs: number,
	costs: { price: number | null; price_cached: number | null } | undefined
): PassMeta {
	return {
		index: pass.index,
		role: pass.role,
		model: modelForPass(cli, pass),
		backend: cli.backend,
		effort: effortForPass(cli, pass) ?? null,
		status: result.status,
		failure_reason: result.failureReason,
		duration_ms: durationMs,
		tool_calls: result.toolCalls,
		submit_attempts: result.submitAttempts,
		prompt_tokens: result.promptTokens,
		completion_tokens: result.completionTokens,
		total_tokens: result.totalTokens,
		cached_prompt_tokens: result.cachedPromptTokens,
		cache_write_tokens: result.cacheWriteTokens,
		providers: result.providers ?? [],
		...(costs ? { price: costs.price, price_cached: costs.price_cached } : {})
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
 * Run-level cost, folded from the PER-PASS numbers rather than recomputed over
 * the merged usage list. Two reasons, both of which produced wrong money:
 *
 * - **Rates are per model.** A `--review-model` split bills two models; pricing
 *   the whole run at the primary model's rates under-reported the README's own
 *   flagship example by ~16x.
 * - **`estimateCachedPrice` assumes an append-only prompt** (request i's prompt
 *   is request i-1's plus new tokens). Each pass starts a FRESH message list
 *   under a different system prompt, so at a pass boundary that premise is false
 *   and the whole opening prompt of pass 2 — review prompt plus the serialized
 *   draft — was billed at the cache-read rate. Per-pass estimation keeps the
 *   premise true inside each pass, where it actually holds.
 *
 * `price` (REAL billed cost) is provider-reported and model-agnostic, so it sums
 * directly. `price_cached` is null when ANY pass could not be priced: a partial
 * counterfactual is not a smaller counterfactual, and the error would always
 * flatter the multi-pass configuration.
 */
export function foldRunCosts(
	passMetas: readonly PassMeta[],
	mergedUsages: ChatUsage[],
	backend: Backend
): { price: number | null; price_cached: number | null } | undefined {
	if (backend !== 'openrouter') return undefined;
	const price = sumRealCost(mergedUsages);
	let cached: number | null = 0;
	for (const pass of passMetas) {
		if (pass.price_cached === null || pass.price_cached === undefined) {
			cached = null;
			break;
		}
		cached += pass.price_cached;
	}
	// No passes ran at all (a throw before the first request): nothing to price.
	return { price, price_cached: passMetas.length === 0 ? null : cached };
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

/**
 * The stderr review-effect block: what the second pass actually changed.
 *
 * Reported per metric and signed, never as one "improved/regressed" verdict. A
 * review pass routinely trades one metric for another — recovering a missed page
 * (recall up) while renaming three items it touched (precision down) — and a
 * single summary number would hide the trade that is the interesting part. This
 * mirrors the scorer's own refusal to average recall with precision.
 */
export function formatPassDelta(before: ScoreReport, after: ScoreReport): string {
	const metrics = [
		['item recall', before.item_recall, after.item_recall],
		['item precision', before.item_precision, after.item_precision],
		['tag recall', before.tag_recall, after.tag_recall],
		['tag precision', before.tag_precision, after.tag_precision],
		['price', before.price_accuracy, after.price_accuracy],
		['description', before.description_accuracy, after.description_accuracy],
		['source recall', before.source_recall, after.source_recall]
	] as const;

	const lines = ['review pass effect (pass 1 → final):'];
	let changed = false;
	for (const [label, from, to] of metrics) {
		const delta = to - from;
		if (Math.abs(delta) < 1e-9) continue;
		changed = true;
		const sign = delta > 0 ? '+' : '';
		lines.push(
			`  ${label.padEnd(16)} ${(from * 100).toFixed(1)}% → ${(to * 100).toFixed(1)}%  ` +
				`(${sign}${(delta * 100).toFixed(1)}pp)`
		);
	}
	if (!changed) lines.push('  no scored metric changed');
	// Item churn is reported even when the ratios did not move: swapping one
	// missed item for another leaves recall identical while changing the answer.
	lines.push(
		`  items ${before.matched} → ${after.matched} matched, ` +
			`${before.hallucinated_items.length} → ${after.hallucinated_items.length} hallucinated`
	);
	return lines.join('\n');
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
		const list = loadBlacklist();
		const spec = harnessFor(cli.harness);
		// EVERY model the run would call, not just the primary one: a reviewer that
		// has been ruled out would otherwise run and spend, and it would do so after
		// pass 1 had already been paid for.
		for (const pass of spec?.passes ?? []) {
			blocked = findBlock(list, {
				model: modelForPass(cli, pass),
				effort: effortForPass(cli, pass),
				backend: cli.backend,
				harness: cli.harness
			});
			if (blocked) break;
		}
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

	// The harness name is validated in parseCli, so this always resolves.
	const harness = harnessFor(cli.harness) as HarnessSpec;

	// Metadata (pricing + supported_parameters) for EVERY model the run will use,
	// fetched once each. A --review-model split bills two models at two rates, so
	// one lookup for the primary model priced the reviewer's tokens wrongly.
	const modelInfos = new Map<string, ModelInfo | null>();
	if (cli.backend === 'openrouter') {
		for (const model of distinctPassModels(harness, cli)) {
			modelInfos.set(model, await fetchModelInfo(model));
		}
	}
	const modelInfoFor = (model: string): ModelInfo | null => modelInfos.get(model) ?? null;

	// Pre-flight: reject an --effort/--temperature a model does not accept BEFORE
	// burning a chat request — for EVERY pass, so an unsupported --review-effort
	// fails here rather than after pass 1 has already been paid for. A
	// missing/unfetchable allowlist NEVER blocks the run: it warns and proceeds
	// (the provider is the source of truth, this is a courtesy).
	if (cli.backend === 'openrouter') {
		for (const pass of harness.passes) {
			const effort = effortForPass(cli, pass);
			if (effort === undefined && cli.temperature === undefined) continue;
			const model = modelForPass(cli, pass);
			const supported = modelInfoFor(model)?.supportedParameters ?? null;
			if (supported === null) {
				console.error(
					`note: could not read supported_parameters for ${model} — skipping pre-flight --effort/--temperature validation`
				);
				continue;
			}
			const err = validateRequestedParams({ effort, temperature: cli.temperature }, supported);
			if (err) {
				console.error(`error: model ${model} (pass ${pass.index}, ${pass.role}) ${err}`);
				return 2;
			}
		}
	}

	const store = new SnapshotStore(join(cli.taskDir, 'snapshot'));
	const transcript: TranscriptEvent[] = [];
	const startedAt = new Date();
	// Claim the directory NOW, and uniquify on collision: two same-task runs
	// launched in the same millisecond otherwise share a name, and the second
	// writeRun silently overwrites the first run's evidence.
	const runDir = claimRunDir(
		join('bench', 'runs', basename(cli.taskDir)),
		`${startedAt.toISOString()}-${modelSlug(cli.model)}`
	);

	const sequence = await runPasses({
		harness,
		cli,
		store,
		entryUrl: manifest.entryUrl,
		transcript,
		apiKey: apiKey ?? '',
		modelInfo: modelInfoFor,
		onPassStart: (pass) => {
			if (harness.passes.length === 1) return;
			const effort = effortForPass(cli, pass);
			console.error(
				`pass ${pass.index}/${harness.passes.length} (${pass.role}) — ` +
					`${modelForPass(cli, pass)}${effort ? ` @ ${effort}` : ''}`
			);
		},
		onPassAbandoned: (pass, reason) => {
			console.error(`pass ${pass.index} (${pass.role}) produced no submission: ${reason}`);
		}
	});
	const { passResults, passMetas, firstPassCandidate } = sequence;

	if (sequence.threw) {
		const { pass, error } = sequence.threw;
		const partial = mergePassResults(passResults);
		// NOT hardcoded null: on a multi-pass harness an earlier pass may have
		// completed and been billed. Discarding that made the run report real
		// tokens with `price: null`, which drops it from every cost mean while its
		// tokens still count.
		const thrownCosts = foldRunCosts(passMetas, partial.usages ?? [], cli.backend);
		const meta = buildMeta(
			cli,
			manifest,
			gold.policy_version,
			startedAt,
			partial,
			thrownCosts,
			invokedAt,
			{},
			passMetas
		);
		// Pass 1's answer is scoreable even though pass 2 died — and that is exactly
		// when you most want to know whether pass 1 was fine.
		writeRun(runDir, {
			meta,
			transcript,
			firstPassCandidate: harness.passes.length > 1 ? firstPassCandidate : undefined,
			firstPassReport:
				harness.passes.length > 1 && firstPassCandidate
					? scoreCandidate(gold, firstPassCandidate)
					: undefined,
			prompts: promptTextsFor(harness)
		});
		console.error(`run failed in pass ${pass.index} (${pass.role}): ${String(error)}`);
		console.error(formatWallClock(meta));
		console.error(`run directory: ${runDir}`);
		return 1;
	}

	const result = mergePassResults(passResults);
	const report = result.candidate ? scoreCandidate(gold, result.candidate) : undefined;
	// Scored against the SAME gold as the final report, so the delta between them
	// is the review pass's effect and nothing else.
	const firstPassReport =
		harness.passes.length > 1 && firstPassCandidate
			? scoreCandidate(gold, firstPassCandidate)
			: undefined;
	const costs = foldRunCosts(passMetas, result.usages ?? [], cli.backend);
	// Resolve the providers this run used to their quantization tiers. Only worth
	// a request when the run actually reported providers; best-effort throughout.
	// Resolved per MODEL: on a drafter/reviewer split the two passes may be served
	// by different providers, and looking every provider up in the PRIMARY model's
	// endpoint table attributed the reviewer's provider a tier that never served
	// it. Later models win ties only for providers the earlier ones did not list.
	let providerQuants: Record<string, string> = {};
	if (cli.backend === 'openrouter' && (result.providers?.length ?? 0) > 0) {
		for (const model of distinctPassModels(harness, cli)) {
			providerQuants = { ...(await fetchProviderQuantizations(model)), ...providerQuants };
		}
	}
	const meta = buildMeta(
		cli,
		manifest,
		gold.policy_version,
		startedAt,
		result,
		costs,
		invokedAt,
		providerQuants,
		passMetas
	);
	writeRun(runDir, {
		meta,
		transcript,
		candidate: result.candidate,
		report,
		firstPassCandidate: harness.passes.length > 1 ? firstPassCandidate : undefined,
		firstPassReport,
		prompts: promptTextsFor(harness)
	});

	if (report) console.error(formatSummary(report));
	else console.error(`run failed: ${result.failureReason ?? 'unknown'}`);
	if (report && firstPassReport) console.error(formatPassDelta(firstPassReport, report));
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
