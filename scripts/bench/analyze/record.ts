/**
 * Bench run index — the read side of `bench/runs/`.
 *
 * Walks the run directories `bench:run` writes and joins each run's `meta.json`
 * and `report.json` into one flat `RunRecord`. Nothing here computes statistics
 * (see `derive.ts` / `aggregate.ts`); this module's only job is turning a tree of
 * loosely-versioned JSON into a typed, uniform row.
 *
 * The central discipline is ABSENT vs ZERO. `meta.json` gained fields over time —
 * `wall_clock_ms`/`invoked_at` (run-duration split), `providers` /
 * `provider_quantizations` / `quantization_requested` (routing provenance) — so
 * older runs simply lack them. Reading a missing field as 0 would invent facts:
 * "no providers" would read as "served by nobody", and a missing wall-clock would
 * read as an instant run. Every optional field is therefore `T | null`, null
 * means UNKNOWN, and callers must render it as unknown rather than as a value.
 * The same care applies to `providers: []`, which means "the backend reported
 * none" and is NOT the same as the key being absent.
 *
 * A run dir that cannot be read never throws: it lands in `problems` so one
 * corrupt directory can't blind the whole index.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScoreReport } from '../score';

/** Where `bench:run` writes, relative to the repo root. */
export const DEFAULT_RUNS_DIR = 'bench/runs';

export type RunStatus = 'scored' | 'failed';

/**
 * One bench run, flattened. Fields sourced from `meta.json` keep their meta
 * names; anything this module synthesizes is documented below.
 */
export interface RunRecord {
	/** Stable identity: `<task>/<run-dir-name>`. Unique across the index. */
	run_id: string;
	/** Task slug (the `bench/runs/<task>/` directory name). */
	task: string;
	/** Path to the run directory, as given to the loader. */
	dir: string;

	// --- configuration -------------------------------------------------------
	model: string;
	backend: string;
	/** Requested reasoning effort, or null when none was passed. */
	effort: string | null;
	/**
	 * Which default applied when `effort` is null (`provider-default` /
	 * `claude-code-default`). Null on runs predating the field.
	 */
	effort_default: string | null;
	temperature: number | null;
	/**
	 * Quantization tiers routing was PINNED to, or null for OpenRouter's default
	 * cheapest-first routing. Null does NOT mean "unquantized" — see the README.
	 */
	quantization_requested: string[] | null;
	/**
	 * Providers that actually served the run, in first-seen order. `null` = the
	 * run predates provenance logging; `[]` = the backend reported none. More
	 * than one entry means OpenRouter re-routed mid-run.
	 */
	providers: string[] | null;
	/** `providers` resolved to tiers. Null when absent; `{}` when the lookup failed. */
	provider_quantizations: Record<string, string> | null;
	/**
	 * The agent setup (harness) that drove the run. A run predating the field is
	 * `single-pass`, which is not a guess: that was the only setup that existed
	 * when it ran. Contrast `prompt_sha`, where absence genuinely means unknown.
	 */
	harness: string;
	/**
	 * Content hash per pass prompt, keyed `<index>-<role>`. NULL on runs predating
	 * the field — an UNKNOWN prompt, not a matching one. Those runs must not pool
	 * with runs whose prompt is recorded, since nothing establishes they agree.
	 */
	prompt_sha: Record<string, string> | null;
	/** Review-pass model override; null when inherited or when there is no review pass. */
	review_model: string | null;
	/** Review-pass effort override; null when inherited or absent. */
	review_effort: string | null;
	/** Per-pass breakdown; empty on runs predating multi-pass harnesses. */
	passes: PassRecord[];
	/** Gold policy version the run was scored against, when recorded. */
	policy_version: string | null;
	entry_url: string | null;
	task_dir: string | null;

	// --- outcome -------------------------------------------------------------
	status: RunStatus;
	failure_reason: string | null;
	started_at: string;
	/** Process-start instant `wall_clock_ms` is measured from. */
	invoked_at: string | null;

	// --- effort / throughput -------------------------------------------------
	/** Agent-run wall-clock: first model request through scoring. Comparable across models. */
	duration_ms: number | null;
	/** TOTAL invocation wall-clock, including bench setup. Null before the field existed. */
	wall_clock_ms: number | null;
	tool_calls: number | null;
	submit_attempts: number | null;

	// --- tokens --------------------------------------------------------------
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	cached_prompt_tokens: number | null;
	cache_write_tokens: number | null;

	// --- cost ----------------------------------------------------------------
	/** Real billed cost, openrouter backend (sum of per-request `usage.cost`). */
	price: number | null;
	/** Counterfactual cost under perfect prefix caching, openrouter backend. */
	price_cached: number | null;
	/** Provider-reported cost, claude backend. */
	total_cost_usd: number | null;

	// --- score ---------------------------------------------------------------
	/**
	 * The frozen report as scored AT RUN TIME. Null on a failed run (which writes
	 * no report). Note this was scored against the gold as it stood then — see
	 * `rescore.ts` for comparing against current gold.
	 */
	report: ScoreReport | null;
	/**
	 * The FIRST pass's frozen report on a multi-pass run (`report-pass1.json`),
	 * null when the run had one pass or predates the artifact. Scored against the
	 * same gold as `report`, so the difference is the review pass's effect.
	 */
	report_pass1: ScoreReport | null;
}

/** One pass of a multi-pass run, as recorded on `meta.passes`. */
export interface PassRecord {
	index: number;
	role: string;
	model: string;
	backend: string;
	effort: string | null;
	status: string;
	failure_reason: string | null;
	duration_ms: number | null;
	tool_calls: number | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	price: number | null;
}

/** A run directory that could not be indexed, and why. */
export interface IndexProblem {
	dir: string;
	error: string;
}

export interface RunIndex {
	runs: RunRecord[];
	problems: IndexProblem[];
	/** Root the index was built from, echoed so the UI can name its source. */
	runsDir: string;
}

// --- field readers ------------------------------------------------------------
// Deliberately narrow: an unexpected type reads as ABSENT rather than being
// coerced, so a malformed meta degrades to "unknown" instead of to a wrong number.

function readString(meta: Record<string, unknown>, key: string): string | null {
	const value = meta[key];
	return typeof value === 'string' ? value : null;
}

function readNumber(meta: Record<string, unknown>, key: string): number | null {
	const value = meta[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(meta: Record<string, unknown>, key: string): string[] | null {
	const value = meta[key];
	if (!Array.isArray(value)) return null;
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function readStringMap(meta: Record<string, unknown>, key: string): Record<string, string> | null {
	const value = meta[key];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'string') out[k] = v;
	}
	return out;
}

/**
 * Build a `RunRecord` from an already-parsed `meta.json` (+ optional report).
 *
 * Split out from disk access so the shape logic is unit-testable without a
 * fixture tree — the same reason the rest of the bench tooling keeps its pure
 * helpers exported.
 */
export function toRunRecord(input: {
	task: string;
	dirName: string;
	dir: string;
	meta: Record<string, unknown>;
	report: ScoreReport | null;
	reportPass1?: ScoreReport | null;
}): RunRecord {
	const { meta } = input;
	const status: RunStatus = readString(meta, 'status') === 'failed' ? 'failed' : 'scored';
	return {
		run_id: `${input.task}/${input.dirName}`,
		task: input.task,
		dir: input.dir,

		model: readString(meta, 'model') ?? '(unknown model)',
		backend: readString(meta, 'backend') ?? '(unknown backend)',
		effort: readString(meta, 'effort'),
		effort_default: readString(meta, 'effort_default'),
		temperature: readNumber(meta, 'temperature'),
		quantization_requested: readStringArray(meta, 'quantization_requested'),
		providers: readStringArray(meta, 'providers'),
		provider_quantizations: readStringMap(meta, 'provider_quantizations'),
		// Absent harness => single-pass: the only setup that existed before the
		// field, so this is a fact about those runs rather than a default.
		harness: readString(meta, 'harness') ?? 'single-pass',
		prompt_sha: readStringMap(meta, 'prompt_sha'),
		review_model: readString(meta, 'review_model'),
		review_effort: readString(meta, 'review_effort'),
		passes: readPasses(meta),
		policy_version: readString(meta, 'policy_version'),
		entry_url: readString(meta, 'entry_url'),
		task_dir: readString(meta, 'task_dir'),

		status,
		failure_reason: readString(meta, 'failure_reason'),
		// started_at is the sort key and the run's identity in time; fall back to
		// the directory name's timestamp prefix, which bench:run always writes.
		started_at: readString(meta, 'started_at') ?? timestampFromDirName(input.dirName) ?? '',
		invoked_at: readString(meta, 'invoked_at'),

		duration_ms: readNumber(meta, 'duration_ms'),
		wall_clock_ms: readNumber(meta, 'wall_clock_ms'),
		tool_calls: readNumber(meta, 'tool_calls'),
		submit_attempts: readNumber(meta, 'submit_attempts'),

		prompt_tokens: readNumber(meta, 'prompt_tokens'),
		completion_tokens: readNumber(meta, 'completion_tokens'),
		total_tokens: readNumber(meta, 'total_tokens'),
		cached_prompt_tokens: readNumber(meta, 'cached_prompt_tokens'),
		cache_write_tokens: readNumber(meta, 'cache_write_tokens'),

		price: readNumber(meta, 'price'),
		price_cached: readNumber(meta, 'price_cached'),
		total_cost_usd: readNumber(meta, 'total_cost_usd'),

		report: input.report ?? null,
		report_pass1: input.reportPass1 ?? null
	};
}

/**
 * Read `meta.passes`. Returns [] for a run that predates multi-pass harnesses —
 * an empty breakdown, never a synthesized one-pass entry: fabricating a pass
 * record would put numbers in the UI that no run actually reported.
 */
function readPasses(meta: Record<string, unknown>): PassRecord[] {
	const raw = meta['passes'];
	if (!Array.isArray(raw)) return [];
	const out: PassRecord[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) continue;
		const p = entry as Record<string, unknown>;
		out.push({
			index: readNumber(p, 'index') ?? 0,
			role: readString(p, 'role') ?? '(unknown role)',
			model: readString(p, 'model') ?? '(unknown model)',
			backend: readString(p, 'backend') ?? '(unknown backend)',
			effort: readString(p, 'effort'),
			status: readString(p, 'status') ?? 'scored',
			failure_reason: readString(p, 'failure_reason'),
			duration_ms: readNumber(p, 'duration_ms'),
			tool_calls: readNumber(p, 'tool_calls'),
			prompt_tokens: readNumber(p, 'prompt_tokens'),
			completion_tokens: readNumber(p, 'completion_tokens'),
			total_tokens: readNumber(p, 'total_tokens'),
			price: readNumber(p, 'price')
		});
	}
	return out.toSorted((a, b) => a.index - b.index);
}

/**
 * Run dirs are named `<iso-timestamp>-<model-slug>`. Recover the timestamp as a
 * fallback sort key when meta lacks `started_at`. Returns null when the prefix
 * isn't a parseable ISO instant.
 */
export function timestampFromDirName(dirName: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-/.exec(dirName);
	if (!match) return null;
	return match[1];
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf-8'));
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Read one frozen report from a run dir. An ABSENT file is expected (a failed
 * run writes none, a single-pass run has no pass-1 report) and returns null
 * silently; a file that exists but will not parse is recorded as a problem
 * rather than swallowed — swallowing it once indexed runs as `scored` with no
 * report, padding every cell's counts while contributing to no metric.
 */
function readReport(dir: string, file: string, index: RunIndex): ScoreReport | null {
	const path = join(dir, file);
	if (!existsSync(path)) return null;
	try {
		const parsed = readJson(path);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error(`${file} is not an object`);
		}
		return parsed as ScoreReport;
	} catch (error) {
		index.problems.push({
			dir,
			error: `${file} unreadable: ${error instanceof Error ? error.message : String(error)}`
		});
		return null;
	}
}

/**
 * Load every run under `runsDir` (`bench/runs` by default).
 *
 * Returns an empty index rather than throwing when the directory is absent:
 * `bench/` is gitignored, so a fresh clone and CI legitimately have no run data,
 * exactly as `bench:lint` and `bench:new --status` already handle.
 */
export function loadRunIndex(runsDir: string = DEFAULT_RUNS_DIR): RunIndex {
	const index: RunIndex = { runs: [], problems: [], runsDir };
	if (!isDir(runsDir)) return index;

	for (const task of readdirSync(runsDir).toSorted()) {
		const taskDir = join(runsDir, task);
		if (!isDir(taskDir)) continue;

		for (const dirName of readdirSync(taskDir).toSorted()) {
			const dir = join(taskDir, dirName);
			if (!isDir(dir)) continue;
			try {
				const meta = readJson(join(dir, 'meta.json'));
				if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
					throw new Error('meta.json is not an object');
				}
				// A failed run writes no report — ABSENT is expected and not a problem.
				// A report that exists but will not parse is a different thing entirely:
				// swallowing it indexed the run as `scored` with no report, so it padded
				// every cell's n_runs/n_scored while contributing to no metric, and
				// nothing anywhere said the file was broken.
				const report = readReport(dir, 'report.json', index);
				// Present only on a multi-pass run; absence is the normal case and
				// never a problem, but an unreadable one is reported like any other.
				const reportPass1 = readReport(dir, 'report-pass1.json', index);
				index.runs.push(
					toRunRecord({
						task,
						dirName,
						dir,
						meta: meta as Record<string, unknown>,
						report,
						reportPass1
					})
				);
			} catch (error) {
				index.problems.push({
					dir,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}

	// Newest first: the question asked of a bench index is almost always "what
	// did the last sweep do".
	index.runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
	return index;
}

/** Read a run's submitted extraction, or null when absent/unparseable. */
export function loadCandidate(dir: string): unknown {
	try {
		return readJson(join(dir, 'candidate.json'));
	} catch {
		return null;
	}
}

/**
 * Read a run's transcript as parsed JSONL events. Kept separate from the index
 * because transcripts are ~180 KB each — an index that eagerly loaded 156 of
 * them would read ~28 MB to answer a leaderboard query that needs none of it.
 * Malformed lines are skipped rather than failing the whole transcript.
 */
export function loadTranscript(dir: string): Record<string, unknown>[] {
	let text: string;
	try {
		text = readFileSync(join(dir, 'transcript.jsonl'), 'utf-8');
	} catch {
		return [];
	}
	const events: Record<string, unknown>[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				events.push(parsed as Record<string, unknown>);
			}
		} catch {
			// A truncated final line (killed mid-write) shouldn't hide the rest.
		}
	}
	return events;
}
