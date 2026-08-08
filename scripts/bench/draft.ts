/**
 * Bench gold drafter.
 *
 * Drives the SAME tool-calling loop as `bench:run` (identical tools, system
 * prompt, and OpenRouter driver) against a task's frozen snapshot, then writes
 * the model's submitted extraction to `<task-dir>/gold/draft.json` — NEVER to
 * gold/data.json. A draft is machine output: a human reviews it against the
 * printed REVIEW checklist and promotes it to gold/data.json by hand.
 *
 * Usage:
 *   bun run bench:draft <task-dir> --model <openrouter-model-id> \
 *     [--effort <level>] [--max-tool-calls N] [--policy-version <v>] [--force]
 *
 * Requires OPENROUTER_API_KEY (exit 2 if unset). Exit 0 once a draft is written
 * (however rough), 1 on a failed model run, 2 on usage/config errors or a
 * refusal to clobber an existing draft.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCorpus, DIETARY_TAGS, lintGold, type LintResult } from './lint';
import { type CandidateMenu } from './score';
import {
	fetchModelInfo,
	openRouterChat,
	OPENROUTER_EFFORT_LEVELS,
	runAgent,
	validateRequestedParams,
	type ChatFn,
	type RunResult,
	type TranscriptEvent
} from './run';
import { loadManifest, SnapshotStore } from './snapshot-store';

const DEFAULT_MAX_TOOL_CALLS = 40;
const DEFAULT_POLICY_VERSION = 'draft';

/** A gold-shaped draft: the submitted candidate stamped with a policy_version. */
export interface Draft {
	policy_version: string;
	sources: string[];
	items: CandidateMenu['items'];
}

/** Stamp a submitted candidate into a gold-shaped draft object. */
export function stampDraft(candidate: CandidateMenu, policyVersion: string): Draft {
	return {
		policy_version: policyVersion,
		sources: candidate.sources,
		items: candidate.items
	};
}

export interface DraftReview {
	itemCount: number;
	itemsWithTags: number;
	itemsWithWarnings: number;
	lint: LintResult;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/**
 * Assemble the review aid for a written draft: reuse the gold linter against the
 * task's own snapshot corpus (zero-hit names, non-verbatim descriptions,
 * unrecorded sources) plus a few tallies for the human reviewer.
 */
export function buildReview(draft: Draft, store: SnapshotStore, run: RunResult): DraftReview {
	const corpus = buildCorpus(store);
	const recordedUrls = new Set(
		store.index.entries.filter((e) => e.method === 'GET').map((e) => e.url)
	);
	const dietary = new Set<string>(DIETARY_TAGS);
	return {
		itemCount: draft.items.length,
		itemsWithTags: draft.items.filter((i) => i.tags.some((t) => dietary.has(t))).length,
		itemsWithWarnings: draft.items.filter((i) => typeof i.warning === 'string').length,
		lint: lintGold(draft, corpus, recordedUrls),
		promptTokens: run.promptTokens,
		completionTokens: run.completionTokens,
		totalTokens: run.totalTokens
	};
}

/** Render the review aid as a human checklist for stderr. */
export function formatReview(draftPath: string, review: DraftReview): string {
	const lines = [
		`REVIEW: ${draftPath}`,
		`  items: ${review.itemCount}  (${review.itemsWithTags} with dietary tags, ${review.itemsWithWarnings} with warnings)`,
		`  tokens: prompt ${review.promptTokens}, completion ${review.completionTokens}, total ${review.totalTokens}`
	];
	for (const e of review.lint.errors) lines.push(`  ! ${e}`);
	for (const w of review.lint.warnings) lines.push(`  ? ${w}`);
	if (review.lint.errors.length === 0 && review.lint.warnings.length === 0) {
		lines.push('  (linter found nothing to flag — still review by hand before promoting)');
	}
	return lines.join('\n');
}

export type DraftOutcome =
	| { status: 'refused'; reason: string; draftPath: string }
	| { status: 'failed'; reason: string; draftPath: string; run: RunResult }
	| { status: 'written'; draftPath: string; review: DraftReview; run: RunResult };

/** Serialize transcript events as JSONL (one event per line, trailing newline). */
function writeTranscript(path: string, transcript: TranscriptEvent[]): void {
	writeFileSync(path, transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Core drafting logic, pure with respect to the network (chat + store injected).
 * Refuses to clobber an existing draft unless `force`; on a scored run writes
 * gold/draft.json (stamped) and builds the review; always writes a transcript
 * once a run happened so a bad draft is debuggable.
 */
export async function draftTask(opts: {
	chat: ChatFn;
	store: SnapshotStore;
	taskDir: string;
	entryUrl: string;
	maxToolCalls: number;
	policyVersion: string;
	force: boolean;
	transcript: TranscriptEvent[];
}): Promise<DraftOutcome> {
	const goldDir = join(opts.taskDir, 'gold');
	const draftPath = join(goldDir, 'draft.json');
	if (existsSync(draftPath) && !opts.force) {
		return {
			status: 'refused',
			reason: `${draftPath} already exists — pass --force to overwrite`,
			draftPath
		};
	}

	const run = await runAgent({
		chat: opts.chat,
		store: opts.store,
		entryUrl: opts.entryUrl,
		maxToolCalls: opts.maxToolCalls,
		transcript: opts.transcript
	});

	mkdirSync(goldDir, { recursive: true });
	writeTranscript(join(goldDir, 'draft-transcript.jsonl'), opts.transcript);

	if (run.status !== 'scored' || !run.candidate) {
		return {
			status: 'failed',
			reason: run.failureReason ?? 'model run did not produce a submission',
			draftPath,
			run
		};
	}

	const draft = stampDraft(run.candidate, opts.policyVersion);
	writeFileSync(draftPath, JSON.stringify(draft, null, '\t') + '\n');
	return { status: 'written', draftPath, review: buildReview(draft, opts.store, run), run };
}

// --- CLI ----------------------------------------------------------------------

export interface CliArgs {
	taskDir: string;
	model: string;
	maxToolCalls: number;
	policyVersion: string;
	force: boolean;
	/** Reasoning-effort level, validated against OpenRouter's set; undefined = provider default. */
	effort?: string;
}

export function parseCli(argv: string[]): CliArgs | { error: string } {
	let taskDir: string | undefined;
	let model: string | undefined;
	let maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
	let policyVersion = DEFAULT_POLICY_VERSION;
	let force = false;
	let effort: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--model') {
			model = argv[++i];
		} else if (arg === '--effort') {
			const level = argv[++i];
			if (level === undefined) return { error: '--effort requires a level' };
			if (!OPENROUTER_EFFORT_LEVELS.includes(level as (typeof OPENROUTER_EFFORT_LEVELS)[number]))
				return {
					error: `--effort must be one of ${OPENROUTER_EFFORT_LEVELS.join('|')} (got ${level})`
				};
			effort = level;
		} else if (arg === '--max-tool-calls') {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0)
				return { error: '--max-tool-calls must be a positive integer' };
			maxToolCalls = n;
		} else if (arg === '--policy-version') {
			policyVersion = argv[++i];
			if (!policyVersion) return { error: '--policy-version requires a value' };
		} else if (arg === '--force') {
			force = true;
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
	return { taskDir, model, maxToolCalls, policyVersion, force, effort };
}

const USAGE =
	'usage: bun run bench:draft <task-dir> --model <openrouter-model-id> [--effort <level>] [--max-tool-calls N] [--policy-version <v>] [--force]';

async function main(): Promise<number> {
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(USAGE);
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

	if (existsSync(join(cli.taskDir, 'gold', 'data.json'))) {
		console.error(
			'note: gold/data.json already exists — drafting over an existing gold (re-verification). ' +
				'The draft goes to gold/draft.json; gold/data.json is left untouched.'
		);
	}

	// Pre-flight: reject an --effort the model does not accept BEFORE burning a chat
	// request. Fetch model info ONLY when --effort is given (no pricing to compute,
	// so the no-flag path stays zero-overhead). A missing/unfetchable allowlist NEVER
	// blocks the run — it warns and proceeds (the provider is the source of truth).
	if (cli.effort !== undefined) {
		const modelInfo = await fetchModelInfo(cli.model);
		const supported = modelInfo?.supportedParameters ?? null;
		if (supported === null) {
			console.error(
				`note: could not read supported_parameters for ${cli.model} — skipping pre-flight --effort validation`
			);
		} else {
			const err = validateRequestedParams({ effort: cli.effort }, supported);
			if (err) {
				console.error(`error: model ${cli.model} ${err}`);
				return 2;
			}
		}
	}

	const store = new SnapshotStore(join(cli.taskDir, 'snapshot'));
	const transcript: TranscriptEvent[] = [];
	// Record the requested reasoning effort (or its absence) so a draft's
	// provenance survives in draft-transcript.jsonl.
	transcript.push({
		type: 'note',
		ts: new Date().toISOString(),
		note: `requested effort: ${cli.effort ?? 'none (provider default)'}`
	});
	let outcome: DraftOutcome;
	try {
		outcome = await draftTask({
			chat: openRouterChat(cli.model, apiKey, { effort: cli.effort }),
			store,
			taskDir: cli.taskDir,
			entryUrl: manifest.entryUrl,
			maxToolCalls: cli.maxToolCalls,
			policyVersion: cli.policyVersion,
			force: cli.force,
			transcript
		});
	} catch (e) {
		console.error(`draft failed: ${String(e)}`);
		return 1;
	}

	if (outcome.status === 'refused') {
		console.error(`error: ${outcome.reason}`);
		return 2;
	}
	if (outcome.status === 'failed') {
		console.error(`draft run failed: ${outcome.reason}`);
		console.error(`transcript: ${join(cli.taskDir, 'gold', 'draft-transcript.jsonl')}`);
		return 1;
	}

	console.error(
		`wrote ${outcome.draftPath} (NOT promoted — review before use) [effort: ${cli.effort ?? 'none (provider default)'}]`
	);
	console.error(formatReview(outcome.draftPath, outcome.review));
	console.error(`transcript: ${join(cli.taskDir, 'gold', 'draft-transcript.jsonl')}`);
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(`fatal: ${String(e)}`);
			process.exit(1);
		});
}
