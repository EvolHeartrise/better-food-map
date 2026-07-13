/**
 * Claude Agent SDK backend for the bench harness.
 *
 * Runs the SAME bench task as `run.ts`'s OpenRouter path, but through the
 * Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) so Claude-model benches
 * bill the user's logged-in Claude Code subscription instead of an API key.
 * The model gets NO built-in tools (no Bash/Read/WebFetch/file access): it is
 * locked to two in-process SDK MCP tools — `fetch_page` and `submit_menu` —
 * that reuse the EXACT same logic as the OpenRouter backend (fetchPage,
 * validateSubmission, applySubmitSanitation), and the SAME byte-identical
 * SYSTEM_PROMPT, so scores stay comparable across backends.
 *
 * The SDK `query()` call sits behind an injectable `queryFn` seam (mirroring
 * `openRouterChat`) so the pure parts — tool handlers, message mapping — are
 * testable without spawning the real CLI.
 */
import {
	createSdkMcpServer,
	query,
	tool,
	type EffortLevel,
	type Options,
	type SDKMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CandidateMenu } from './score';
import {
	applySubmitSanitation,
	fetchPage,
	SYSTEM_PROMPT,
	validateSubmission,
	type RunResult,
	type TranscriptEvent
} from './run';
import type { SnapshotStore } from './snapshot-store';

const MCP_SERVER_NAME = 'bench';
const FETCH_PAGE_TOOL = 'fetch_page';
const SUBMIT_MENU_TOOL = 'submit_menu';
const MAX_SUBMIT_ATTEMPTS = 3;

/** The two — and only two — tools the bench model may call, MCP-namespaced. */
export const CLAUDE_ALLOWED_TOOLS = [
	`mcp__${MCP_SERVER_NAME}__${FETCH_PAGE_TOOL}`,
	`mcp__${MCP_SERVER_NAME}__${SUBMIT_MENU_TOOL}`
];

/**
 * Built-in Claude Code tools we deny outright. `tools: []` already strips all
 * built-ins from context; this is belt-and-suspenders so a stray built-in name
 * (e.g. from a skill doc) can never execute — the bench model must reach the
 * site ONLY through fetch_page.
 */
const DISALLOWED_BUILTINS = [
	'Bash',
	'BashOutput',
	'Read',
	'Edit',
	'Write',
	'NotebookEdit',
	'WebFetch',
	'WebSearch',
	'Glob',
	'Grep',
	'Task',
	'TodoWrite',
	'KillShell'
];

// --- tool handlers (pure, shared with the SDK tool wrappers) ------------------

/** Mutable run state threaded through the submit handler. */
export interface ClaudeRunState {
	submitAttempts: number;
	candidate?: CandidateMenu;
	done: boolean;
}

export function newRunState(): ClaudeRunState {
	return { submitAttempts: 0, candidate: undefined, done: false };
}

/** Wrap any JSON-serializable value as an MCP text tool result. */
function textResult(value: unknown, isError = false): CallToolResult {
	const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(value) }] };
	if (isError) result.isError = true;
	return result;
}

/** fetch_page handler: serve the URL from the snapshot, identical to run.ts. */
export function fetchPageToolResult(store: SnapshotStore, url: string): CallToolResult {
	return textResult(fetchPage(store, url));
}

/**
 * submit_menu handler: validate against CandidateSchema. A failure returns its
 * issues so the model can retry (up to MAX_SUBMIT_ATTEMPTS, enforced by the
 * loop); a success applies the shared trailing-junk sanitation, captures the
 * candidate, and flags the run done. Same semantics as the OpenRouter backend.
 */
export function submitToolResult(state: ClaudeRunState, payload: unknown): CallToolResult {
	state.submitAttempts += 1;
	const submission = validateSubmission(payload);
	if (submission.ok) {
		applySubmitSanitation(submission.candidate);
		state.candidate = submission.candidate;
		state.done = true;
		return textResult({ ok: true });
	}
	return textResult({ ok: false, issues: submission.issues }, true);
}

// --- SDK MCP server ------------------------------------------------------------

const FETCH_PAGE_DESC =
	'Fetch a page from the restaurant website snapshot. Returns the page text and, ' +
	'for HTML pages, a list of links found on the page. Use it to navigate the site and ' +
	'discover every menu page. URLs not in the snapshot return status 404.';

const SUBMIT_MENU_DESC =
	'Submit your final, exhaustive menu extraction. Call this exactly once when done.';

// Loose-but-guiding zod schema; the hard vocabulary/shape check is done by
// validateSubmission (the scorer's CandidateSchema) inside the handler.
const submitInputSchema = {
	sources: z.array(z.string()),
	items: z.array(
		z.object({
			name: z.string(),
			description: z.string().nullable(),
			tags: z.array(z.string()),
			optional_tags: z.array(z.string()),
			price: z.number().nullable(),
			warning: z.string().nullable().optional()
		})
	)
};

/** Build the in-process MCP server exposing the two bench tools. */
export function buildBenchMcpServer(store: SnapshotStore, state: ClaudeRunState) {
	const fetchPageTool = tool(
		FETCH_PAGE_TOOL,
		FETCH_PAGE_DESC,
		{ url: z.string().describe('Absolute URL to fetch.') },
		async ({ url }) => fetchPageToolResult(store, url)
	);
	const submitMenuTool = tool(SUBMIT_MENU_TOOL, SUBMIT_MENU_DESC, submitInputSchema, async (args) =>
		submitToolResult(state, args)
	);
	return createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: '1.0.0',
		tools: [fetchPageTool, submitMenuTool]
	});
}

// --- SDK message → TranscriptEvent mapping ------------------------------------

/** Read a numeric usage field defensively from an unknown usage object. */
function usageField(usage: unknown, key: string): number {
	if (usage && typeof usage === 'object') {
		const value = (usage as Record<string, unknown>)[key];
		if (typeof value === 'number') return value;
	}
	return 0;
}

/** Strip the `mcp__<server>__` prefix so transcript tool names match run.ts. */
function stripMcpPrefix(name: string): string {
	const parts = name.split('__');
	return parts.length === 3 && parts[0] === 'mcp' ? parts[2] : name;
}

/**
 * Map one SDK message into the harness's TranscriptEvent format, so bench/runs
 * artifacts are uniform across backends: assistant text → a `response` event
 * (with usage), each tool_use block → a `tool_call`, each tool_result block on
 * a user message → a `tool_result`, and the final result → a `note` carrying
 * usage + cost. Non-conversational SDK message types map to nothing.
 *
 * The SDK emits ONE SDKAssistantMessage per content block of a single API
 * request (a text block, then a tool_use block, …), and every one of those
 * events carries the SAME underlying API message (`msg.message.id`) and its
 * SAME usage. Emitting a `response` event (which carries usage) for each would
 * duplicate every request's usage line in the transcript and double-count
 * tokens. Pass `seenMessageIds` to dedupe: the `response` event — the one that
 * carries usage — is emitted only the FIRST time an API message id is seen,
 * while every `tool_use` block still maps to its own `tool_call` (those never
 * repeat across the per-block events). Omit the set for one-shot mapping.
 */
export function mapSdkMessage(msg: SDKMessage, seenMessageIds?: Set<string>): TranscriptEvent[] {
	const ts = new Date().toISOString();
	const events: TranscriptEvent[] = [];
	if (msg.type === 'assistant') {
		const messageId = msg.message.id;
		const firstSeen =
			seenMessageIds === undefined ||
			typeof messageId !== 'string' ||
			!seenMessageIds.has(messageId);
		if (seenMessageIds !== undefined && typeof messageId === 'string')
			seenMessageIds.add(messageId);
		const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
		const text = blocks
			.filter((b) => b.type === 'text')
			.map((b) => (b.type === 'text' ? b.text : ''))
			.join('');
		if (firstSeen) {
			events.push({
				type: 'response',
				ts,
				usage: msg.message.usage,
				message: { role: 'assistant', content: text.length > 0 ? text : null }
			});
		}
		for (const b of blocks) {
			if (b.type === 'tool_use') {
				events.push({
					type: 'tool_call',
					ts,
					id: b.id,
					name: stripMcpPrefix(b.name),
					arguments: b.input
				});
			}
		}
	} else if (msg.type === 'user') {
		const content = msg.message.content;
		const blocks = Array.isArray(content) ? content : [];
		for (const b of blocks) {
			if (b.type === 'tool_result') {
				events.push({ type: 'tool_result', ts, id: b.tool_use_id, result: b.content });
			}
		}
	} else if (msg.type === 'result') {
		events.push({
			type: 'note',
			ts,
			note: `sdk result: ${msg.subtype}`,
			usage: msg.usage,
			total_cost_usd: msg.total_cost_usd
		});
	}
	return events;
}

// --- the SDK query seam + agent runner ----------------------------------------

/**
 * The bench tools bound to a run's state — the same functions the SDK MCP
 * server invokes. Exposed to the `queryFn` seam so a fake driver can invoke
 * them exactly as the real CLI would (driving `state.done`) without a subprocess.
 */
export interface BenchToolHandlers {
	fetchPage(url: string): CallToolResult;
	submit(payload: unknown): CallToolResult;
}

/** Injectable seam over the SDK `query()` — a fake drives tests without a CLI. */
export type QueryFn = (params: {
	prompt: string;
	options: Options;
	tools: BenchToolHandlers;
}) => AsyncIterable<SDKMessage>;

const defaultQueryFn: QueryFn = ({ prompt, options }) => query({ prompt, options });

/**
 * Build the SDK options that lock the bench model to exactly the two MCP tools:
 * `tools: []` drops all built-ins, `allowedTools` auto-approves ONLY the bench
 * tools, `disallowedTools` denies built-ins by name, `settingSources: []` +
 * `strictMcpConfig` ignore on-disk settings/CLAUDE.md/other MCP servers, and
 * `systemPrompt` (a string) REPLACES the Claude Code preset with the bench
 * prompt. `bypassPermissions` runs the whitelisted tools headlessly.
 */
export function buildClaudeOptions(
	server: ReturnType<typeof buildBenchMcpServer>,
	model: string,
	maxToolCalls: number,
	abortController: AbortController,
	effort?: EffortLevel
): Options {
	return {
		model,
		systemPrompt: SYSTEM_PROMPT,
		// `effort` guides the SDK's adaptive-thinking depth. Omitted when unset so
		// the Claude Code harness default (xhigh) applies; the SDK's own default is
		// `high`. Levels: low|medium|high|xhigh|max (EffortLevel).
		...(effort !== undefined ? { effort } : {}),
		// A turn can carry several tool calls, so maxTurns is a loose upper bound
		// on the same budget the OpenRouter backend spends as tool calls.
		maxTurns: maxToolCalls,
		tools: [],
		allowedTools: CLAUDE_ALLOWED_TOOLS,
		disallowedTools: DISALLOWED_BUILTINS,
		mcpServers: { [MCP_SERVER_NAME]: server },
		strictMcpConfig: true,
		settingSources: [],
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
		abortController,
		includePartialMessages: false
	};
}

export interface ClaudeAgentOpts {
	model: string;
	store: SnapshotStore;
	entryUrl: string;
	maxToolCalls: number;
	/** Reasoning-effort level → SDK `Options.effort`; undefined = harness default. */
	effort?: EffortLevel;
	transcript: TranscriptEvent[];
	/** Test seam; defaults to the real SDK `query()`. */
	queryFn?: QueryFn;
}

/**
 * Drive the bench task through the Claude Agent SDK, returning the SAME
 * RunResult shape as `runAgent` so run.ts's scoring/meta/writeRun path is
 * shared. On a valid submit we stop the streaming query via the
 * AbortController (the SDK loop does not end on a tool result) and ignore any
 * further turns — a deliberate choice: it forgoes the final `result` message's
 * usage/cost on a successful submit, but per-request usage is already
 * accumulated (deduped by API message id), so token counts are complete either
 * way.
 */
export async function runClaudeAgent(opts: ClaudeAgentOpts): Promise<RunResult> {
	const { model, store, entryUrl, maxToolCalls, transcript } = opts;
	const queryFn = opts.queryFn ?? defaultQueryFn;
	const state = newRunState();
	const server = buildBenchMcpServer(store, state);
	const abortController = new AbortController();
	const options = buildClaudeOptions(server, model, maxToolCalls, abortController, opts.effort);
	const prompt = `The restaurant’s website entry URL is: ${entryUrl}`;
	// Same handlers the SDK server wraps, exposed via the seam for test drivers.
	const tools: BenchToolHandlers = {
		fetchPage: (url) => fetchPageToolResult(store, url),
		submit: (payload) => submitToolResult(state, payload)
	};

	let toolCalls = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let cachedPromptTokens = 0;
	let cacheWriteTokens = 0;
	let totalCostUsd: number | undefined;
	let failureReason: string | undefined;
	// Dedupe usage by API message id: the SDK emits one assistant event per
	// content block, all sharing one message id + usage (see mapSdkMessage).
	// Usage rides the (deduped) `response` event, so accumulating it there
	// counts each API request's tokens exactly once.
	const seenMessageIds = new Set<string>();

	try {
		for await (const msg of queryFn({ prompt, options, tools })) {
			for (const ev of mapSdkMessage(msg, seenMessageIds)) {
				transcript.push(ev);
				if (ev.type === 'tool_call') toolCalls += 1;
				if (ev.type === 'response') {
					promptTokens += usageField(ev.usage, 'input_tokens');
					completionTokens += usageField(ev.usage, 'output_tokens');
					cachedPromptTokens += usageField(ev.usage, 'cache_read_input_tokens');
					cacheWriteTokens += usageField(ev.usage, 'cache_creation_input_tokens');
				}
			}
			if (msg.type === 'result') {
				// A natural end-of-run: prefer the authoritative result totals.
				promptTokens = usageField(msg.usage, 'input_tokens') || promptTokens;
				completionTokens = usageField(msg.usage, 'output_tokens') || completionTokens;
				cachedPromptTokens = usageField(msg.usage, 'cache_read_input_tokens') || cachedPromptTokens;
				cacheWriteTokens = usageField(msg.usage, 'cache_creation_input_tokens') || cacheWriteTokens;
				totalCostUsd = msg.total_cost_usd;
				if (msg.subtype !== 'success' && state.candidate === undefined) {
					failureReason ??= `sdk result: ${msg.subtype}`;
				}
			}
			if (state.done) {
				abortController.abort();
				break;
			}
			if (state.submitAttempts >= MAX_SUBMIT_ATTEMPTS && state.candidate === undefined) {
				failureReason = `submit_menu failed validation ${MAX_SUBMIT_ATTEMPTS} times`;
				abortController.abort();
				break;
			}
		}
	} catch (e) {
		// An abort we triggered ourselves is expected; anything else is a failure.
		if (!abortController.signal.aborted) failureReason ??= String(e);
	}

	const scored = state.candidate !== undefined;
	return {
		status: scored ? 'scored' : 'failed',
		failureReason: scored ? undefined : (failureReason ?? 'model did not submit a valid menu'),
		candidate: state.candidate,
		toolCalls,
		submitAttempts: state.submitAttempts,
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedPromptTokens,
		cacheWriteTokens,
		totalCostUsd
	};
}
