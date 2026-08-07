/**
 * Bench analytics viewer — local dashboard over `bench/runs`.
 *
 * Serves a read-only JSON API plus the built Svelte SPA in `bench-viewer/`.
 * Everything it reports comes from `scripts/bench/analyze/*`, the same modules
 * `bench:export` uses, so a number on screen always equals the number in a CSV.
 *
 * Usage:
 *   bun run bench:viewer [--port 8792] [--runs-dir <dir>] [--tasks-dir <dir>]
 *                        [--blacklist <file>] [--read-only] [--rebuild] [--no-build]
 *
 * The SPA is built with Vite on demand: if `bench-viewer/dist` is missing or
 * older than any file under `bench-viewer/src`, it is rebuilt before serving
 * (`--rebuild` forces, `--no-build` skips). That keeps the tool a single
 * command with no separate dev server to remember.
 *
 * WRITES: the only thing this server can change is the model/config BLACKLIST
 * (`scripts/bench/blacklist.json`). That is deliberate and it is not a hole in
 * the read-only rule — the rule protects the CORPUS, because an analytics tool
 * that can edit its own evidence is a way to lose it. The blacklist is not
 * evidence; it is a git-tracked record of DECISIONS made from the evidence, and
 * the view where you read the numbers is the right place to record the verdict
 * they support. Nothing under `bench/` is ever written. `--read-only` disables
 * the two mutating endpoints entirely.
 *
 * Binds 127.0.0.1 only. This reads unpublished bench data and has no auth, so
 * it must never be reachable off the machine. All human output is on stderr;
 * exit 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { addEntry, removeEntries, saveBlacklist, today, type BlacklistEntry } from './blacklist';
import {
	BLACKLIST_PATH,
	blockFor,
	hideBlacklisted,
	loadBlacklistSafe,
	modelStates,
	scopeCoverage,
	statusFor,
	toInfo,
	type Blacklist
} from './analyze/blacklist';
import {
	buildCells,
	DEFAULT_DIMENSIONS,
	DIMENSIONS,
	filterRuns,
	METRIC_KEYS,
	taskDiscrimination,
	type AverageMode,
	type Cell,
	type Dimension,
	type MetricKey,
	type RunFilter
} from './analyze/aggregate';
import { analyzeNameFidelity, deriveRun } from './analyze/derive';
import { cellRow, runRow } from './analyze/export';
import {
	DEFAULT_RUNS_DIR,
	loadCandidate,
	loadRunIndex,
	loadTranscript,
	type RunIndex,
	type RunRecord
} from './analyze/record';
import {
	clearGoldCache,
	DEFAULT_TASKS_DIR,
	loadGold,
	rescoreRun,
	taskDirFor
} from './analyze/rescore';
import { buildTimeline, fetchedUrls, pageCoverage } from './analyze/transcript';
import { loadManifest } from './snapshot-store';

const VIEWER_ROOT = 'bench-viewer';
const DIST_DIR = join(VIEWER_ROOT, 'dist');

// --- CLI ----------------------------------------------------------------------

export interface ViewerArgs {
	port: number;
	runsDir: string;
	tasksDir: string;
	/** Where the model/config verdicts live. Git-tracked, NOT under `bench/`. */
	blacklistPath: string;
	/** When true the blacklist endpoints refuse to write. */
	readOnly: boolean;
	rebuild: boolean;
	build: boolean;
}

export type ArgsResult = { ok: true; args: ViewerArgs } | { ok: false; error: string };

const USAGE =
	'usage: bun run bench:viewer [--port 8792] [--runs-dir <dir>] [--tasks-dir <dir>] ' +
	'[--blacklist <file>] [--read-only] [--rebuild] [--no-build]';

export function parseArgs(argv: readonly string[]): ArgsResult {
	const args: ViewerArgs = {
		port: 8792,
		runsDir: DEFAULT_RUNS_DIR,
		tasksDir: DEFAULT_TASKS_DIR,
		blacklistPath: BLACKLIST_PATH,
		readOnly: false,
		rebuild: false,
		build: true
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		// A value that is itself a flag means the user forgot one: `--runs-dir
		// --rebuild` would otherwise silently set runsDir to "--rebuild" and report
		// "0 runs" with exit 0.
		const raw = argv[i + 1];
		const value = raw !== undefined && raw.startsWith('--') ? undefined : raw;
		switch (flag) {
			case '--port': {
				// Number() would accept "0x1F90" and " 80 "; a port is decimal digits.
				if (!value || !/^\d+$/.test(value)) {
					return { ok: false, error: '--port must be a decimal port number' };
				}
				const port = Number(value);
				if (port < 1 || port > 65535) {
					return { ok: false, error: '--port must be between 1 and 65535' };
				}
				args.port = port;
				i++;
				break;
			}
			case '--runs-dir':
				if (!value) return { ok: false, error: '--runs-dir needs a path' };
				args.runsDir = value;
				i++;
				break;
			case '--tasks-dir':
				if (!value) return { ok: false, error: '--tasks-dir needs a path' };
				args.tasksDir = value;
				i++;
				break;
			case '--blacklist':
				if (!value) return { ok: false, error: '--blacklist needs a path' };
				args.blacklistPath = value;
				i++;
				break;
			case '--read-only':
				args.readOnly = true;
				break;
			case '--rebuild':
				args.rebuild = true;
				break;
			case '--no-build':
				args.build = false;
				break;
			default:
				return { ok: false, error: `unknown argument: ${flag}` };
		}
	}
	return { ok: true, args };
}

// --- index cache --------------------------------------------------------------

/**
 * Re-scan at most this often. The index is ~300 small JSON reads, so a short TTL
 * keeps a page load cheap while still picking up a sweep that finished seconds
 * ago — no file watcher needed, and none wanted: a recursive watch over
 * `bench/tasks` would watch a ~289 MB snapshot tree to learn nothing.
 */
const INDEX_TTL_MS = 2000;

class IndexCache {
	private cached: RunIndex | null = null;
	private at = 0;

	constructor(
		private readonly runsDir: string,
		private readonly now: () => number = () => Date.now()
	) {}

	get(): RunIndex {
		const now = this.now();
		if (!this.cached || now - this.at > INDEX_TTL_MS) {
			this.cached = loadRunIndex(this.runsDir);
			// Gold can change under us too (a bench:review promote), and rescoring
			// reads it — so the two caches expire together or rescores go stale.
			clearGoldCache();
			this.at = now;
		}
		return this.cached;
	}
}

/**
 * The blacklist, re-read on the same TTL as the index — `bench:blacklist --add`
 * in another terminal must show up here without a restart — but invalidated
 * IMMEDIATELY on our own write, so the response to a POST already reflects it.
 * A verdict recorded in the UI that took two seconds to take effect would read
 * as a failed click.
 */
class BlacklistCache {
	private cached: { list: Blacklist; error: string | null } | null = null;
	private at = 0;

	constructor(
		private readonly path: string,
		private readonly now: () => number = () => Date.now()
	) {}

	get(): { list: Blacklist; error: string | null } {
		const now = this.now();
		if (!this.cached || now - this.at > INDEX_TTL_MS) {
			this.cached = loadBlacklistSafe(this.path);
			this.at = now;
		}
		return this.cached;
	}

	invalidate(): void {
		this.cached = null;
	}
}

// --- request helpers ----------------------------------------------------------

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/** Repeated query params (`?task=a&task=b`) as a list; empty means "no filter". */
function list(url: URL, key: string): string[] {
	return url.searchParams.getAll(key).filter((value) => value.length > 0);
}

export function parseMode(raw: string | null): AverageMode {
	return raw === 'micro' ? 'micro' : 'macro';
}

export function parseMetric(raw: string | null): MetricKey {
	return (METRIC_KEYS as readonly string[]).includes(raw ?? '')
		? (raw as MetricKey)
		: 'item_recall';
}

/** Validate a requested grouping, falling back to the default on anything unknown. */
export function parseDimensions(raw: string | null): Dimension[] {
	if (!raw) return DEFAULT_DIMENSIONS;
	const wanted = raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => (DIMENSIONS as readonly string[]).includes(part)) as Dimension[];
	return wanted.length > 0 ? wanted : DEFAULT_DIMENSIONS;
}

export function filterFromQuery(url: URL): RunFilter {
	return {
		tasks: list(url, 'task'),
		models: list(url, 'model'),
		backends: list(url, 'backend'),
		efforts: list(url, 'effort'),
		policyVersions: list(url, 'policy_version'),
		includeFailed: url.searchParams.get('include_failed') !== '0',
		since: url.searchParams.get('since') ?? undefined,
		until: url.searchParams.get('until') ?? undefined
	};
}

/**
 * Retired configurations are hidden unless asked for.
 *
 * Opt-IN rather than opt-out because the default reading of this dashboard is
 * "what should we run", and a configuration we have already decided against is
 * noise in that question — it is also, unhelpfully, often near the top, since
 * plenty of blacklist entries were written about configs that scored WELL and
 * lost on cost. The count hidden is reported on every response that hides any,
 * so the slice never silently narrows.
 */
export function includeBlacklistedFromQuery(url: URL): boolean {
	return url.searchParams.get('include_blacklisted') === '1';
}

/** Cells minus their run objects — the client only needs ids to drill down. */
function serializeCell(cell: Cell, blacklist: Blacklist): Record<string, unknown> {
	return {
		...cellRow(cell),
		metrics: cell.metrics,
		policy_conflicts: cell.policy_conflicts,
		provenances: cell.provenances,
		run_ids: cell.runs.map((run) => run.run_id),
		blacklist: statusFor(cell.runs, blacklist),
		stats: {
			cost_usd: cell.cost_usd,
			price_cached: cell.price_cached,
			duration_ms: cell.duration_ms,
			total_tokens: cell.total_tokens,
			cache_hit_rate: cell.cache_hit_rate,
			output_tok_per_s: cell.output_tok_per_s,
			unsafe_tag_claims: cell.unsafe_tag_claims
		}
	};
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].toSorted();
}

/**
 * The blacklist register, in one shape.
 *
 * Shared by `/api/blacklist`, the write replies and the `blacklist` block of
 * `/api/overview` so all four cannot drift — a "writable" that disagreed between
 * the register and the overview would show Remove buttons that 403.
 */
function blacklistPayload(
	args: ViewerArgs,
	blacklist: Blacklist,
	blacklistError: string | null,
	runs: readonly RunRecord[]
): Record<string, unknown> {
	return {
		path: args.blacklistPath,
		/** Null unless the file is unreadable — then the UI says so, never "empty". */
		error: blacklistError,
		writable: !args.readOnly && blacklistError === null,
		entries: blacklist.entries.map((entry) => toInfo(entry, runs)),
		model_states: modelStates(runs, blacklist),
		/** Runs the default view hides. Reported so the hiding is never silent. */
		n_blocked_runs: runs.length - hideBlacklisted(runs, blacklist).length
	};
}

/**
 * Facets for the filter UI, derived from the corpus rather than hardcoded.
 *
 * Deliberately computed over the WHOLE index, blacklist hiding included: the
 * header describes the corpus on disk, and the model chip you need in order to
 * un-hide a retired model must not itself be hidden by the hiding.
 */
function overview(
	index: RunIndex,
	args: ViewerArgs,
	blacklist: Blacklist,
	blacklistError: string | null
): Record<string, unknown> {
	const runs = index.runs;
	return {
		runs_dir: args.runsDir,
		tasks_dir: args.tasksDir,
		blacklist: blacklistPayload(args, blacklist, blacklistError, runs),
		counts: {
			runs: runs.length,
			scored: runs.filter((run) => run.status === 'scored').length,
			failed: runs.filter((run) => run.status === 'failed').length,
			tasks: uniqueSorted(runs.map((run) => run.task)).length,
			models: uniqueSorted(runs.map((run) => run.model)).length
		},
		facets: {
			tasks: uniqueSorted(runs.map((run) => run.task)),
			models: uniqueSorted(runs.map((run) => run.model)),
			backends: uniqueSorted(runs.map((run) => run.backend)),
			efforts: uniqueSorted(
				runs.map((run) => run.effort ?? `default(${run.effort_default ?? 'unknown'})`)
			),
			policy_versions: uniqueSorted(runs.map((run) => run.policy_version ?? 'unknown')),
			metrics: [...METRIC_KEYS],
			dimensions: [...DIMENSIONS]
		},
		problems: index.problems,
		/** Runs whose provenance was never recorded — they cannot be attributed. */
		unattributed_runs: runs.filter((run) => run.providers === null).length
	};
}

function runDetail(
	run: RunRecord,
	tasksDir: string,
	blacklist: Blacklist
): Record<string, unknown> {
	const taskDir = taskDirFor(run, tasksDir);
	const events = loadTranscript(run.dir);
	const fetched = fetchedUrls(events);
	const { gold } = loadGold(taskDir);
	const candidate = loadCandidate(run.dir) as { items?: { name?: string }[] } | null;
	const rescore = rescoreRun(run, tasksDir);

	// The full item lists sharpen the duplicate guard in the fidelity overlay.
	const context = {
		goldNames: gold?.items?.map((item) => item.name),
		candidateNames: Array.isArray(candidate?.items)
			? candidate.items
					.map((item) => item?.name)
					.filter((name): name is string => typeof name === 'string')
			: undefined
	};

	/**
	 * Both variants, computed here rather than in the browser: the overlay lives
	 * in the tested module, and the viewer must never render the frozen fidelity
	 * beside rescored numbers — that would show two different golds in one tab.
	 */
	const fidelityFor = (report: typeof run.report) =>
		report
			? analyzeNameFidelity(
					Array.isArray(report.missed_items) ? report.missed_items : [],
					Array.isArray(report.hallucinated_items) ? report.hallucinated_items : [],
					context
				)
			: null;

	const block = blockFor(run, blacklist);

	return {
		run,
		derived: deriveRun(run),
		/**
		 * The verdict covering THIS run's configuration, or null. Present even when
		 * the run is being viewed through a slice that hides its config: a run you
		 * deep-linked to must tell you it is retired rather than looking ordinary.
		 */
		blacklist: block === null ? null : toInfo(block),
		name_fidelity: fidelityFor(run.report),
		name_fidelity_current: fidelityFor(rescore.current),
		rescore,
		page_coverage: pageCoverage(loadManifest(taskDir), fetched),
		fetched_urls: fetched,
		timeline: buildTimeline(events),
		gold_items: gold?.items ?? null,
		candidate_items: Array.isArray(candidate?.items) ? candidate.items : null,
		/**
		 * What the review pass changed, on a multi-pass run — null on a single-pass
		 * one, which is a different fact from "changed nothing" (that is a zero
		 * delta). Computed from the two FROZEN reports, so it says what the review
		 * did at run time; the rescore block above is the separate question of
		 * whether today's gold still agrees.
		 */
		review_effect: reviewEffect(run)
	};
}

/**
 * Per-metric effect of the review pass: the pass-1 score, the final score, and
 * the signed difference. Null unless the run recorded a pass-1 report.
 *
 * Deliberately NOT collapsed into an "improved / regressed" verdict. A reviewer
 * routinely recovers a missed page (recall up) while renaming items it touched
 * (precision down), and the trade is the interesting part — the same reason the
 * scorer never averages recall with precision.
 */
function reviewEffect(run: RunRecord): Record<string, unknown> | null {
	const before = run.report_pass1;
	const after = run.report;
	if (!before || !after) return null;
	const metrics: Record<string, { before: number; after: number; delta: number }> = {};
	for (const key of METRIC_KEYS) {
		const b = before[key];
		const a = after[key];
		if (typeof b !== 'number' || typeof a !== 'number') continue;
		metrics[key] = { before: b, after: a, delta: a - b };
	}
	return {
		metrics,
		matched: { before: before.matched, after: after.matched },
		hallucinated: {
			before: before.hallucinated_items.length,
			after: after.hallucinated_items.length
		},
		// Items the review pass ADDED to / REMOVED from the miss list: churn that a
		// ratio cannot show, since swapping one miss for another leaves it flat.
		newly_found: before.missed_items.filter((n) => !after.missed_items.includes(n)).toSorted(),
		newly_missed: after.missed_items.filter((n) => !before.missed_items.includes(n)).toSorted()
	};
}

// --- static assets ------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2'
};

function contentType(path: string): string {
	const dot = path.lastIndexOf('.');
	return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? 'application/octet-stream';
}

/**
 * Resolve a URL path inside `dist`, refusing anything that escapes it.
 * Exported for testing: path traversal on a localhost tool is still a bug.
 */
export function resolveAsset(distDir: string, pathname: string): string | null {
	const decoded = (() => {
		try {
			return decodeURIComponent(pathname);
		} catch {
			return null;
		}
	})();
	if (decoded === null || decoded.includes('\0')) return null;

	const root = resolve(distDir);
	const target = resolve(root, `.${normalize(decoded)}`);
	if (target !== root && !target.startsWith(root + sep)) return null;
	return target;
}

/** mtime of a single file, or 0 when it doesn't exist. */
function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Newest mtime under a directory tree, or 0 when it doesn't exist. */
function newestMtime(dir: string): number {
	if (!existsSync(dir)) return 0;
	let newest = 0;
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else newest = Math.max(newest, statSync(path).mtimeMs);
		}
	};
	walk(dir);
	return newest;
}

/**
 * Build the SPA if `dist` is missing or stale. Returns false when the build
 * failed, so the caller can serve the API and say plainly that the UI is absent
 * rather than serving a blank page.
 */
export function ensureBuilt(options: { force: boolean; enabled: boolean }): boolean {
	if (!existsSync(VIEWER_ROOT)) {
		console.error(`no ${VIEWER_ROOT}/ directory — serving the API only`);
		return false;
	}
	const distIndex = join(DIST_DIR, 'index.html');
	// Every build INPUT, not just src/: index.html is Vite's entry (it holds the
	// script tag and the mount point) and vite.config.ts carries the Svelte
	// compiler options. Watching only src/ meant editing either one served a stale
	// bundle forever, with nothing on screen to say so.
	const newestSource = Math.max(
		newestMtime(join(VIEWER_ROOT, 'src')),
		mtimeOf(join(VIEWER_ROOT, 'index.html')),
		mtimeOf(join(VIEWER_ROOT, 'vite.config.ts'))
	);
	const stale = newestSource > newestMtime(DIST_DIR);
	const needsBuild = options.force || !existsSync(distIndex) || stale;

	if (!needsBuild) return true;
	if (!options.enabled) {
		console.error('UI bundle is stale and --no-build was passed — serving what is on disk');
		return existsSync(distIndex);
	}

	console.error('building the viewer UI…');
	const result = spawnSync('bunx', ['--bun', 'vite', 'build'], {
		cwd: VIEWER_ROOT,
		stdio: ['ignore', 'inherit', 'inherit']
	});
	if (result.status === 0) return true;

	// A failed rebuild is not a reason to throw away a bundle that already works:
	// serving 503 while dist/index.html sits there is simply false.
	if (existsSync(distIndex)) {
		console.error('viewer UI build failed — serving the PREVIOUS (stale) bundle');
		return true;
	}
	console.error('viewer UI build failed and no previous bundle exists — serving the API only');
	return false;
}

// --- server -------------------------------------------------------------------

/**
 * Only requests addressed to this machine by name are served.
 *
 * Binding to 127.0.0.1 does NOT make the server unreachable from a browser: a
 * page on any site can point a hostname at 127.0.0.1 (DNS rebinding) and then
 * read every response same-origin, because nothing here requires credentials.
 * Checking the Host header closes that, and costs one comparison.
 */
export function isAllowedHost(hostHeader: string | null): boolean {
	if (!hostHeader) return false;
	// Strip the port; handle bracketed IPv6.
	const host = hostHeader.startsWith('[')
		? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
		: hostHeader.split(':')[0];
	return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/**
 * Guard for the two mutating endpoints.
 *
 * `isAllowedHost` already stops DNS rebinding, but a rebound page could still
 * reach a same-origin-looking POST, so writes get two more cheap checks:
 *
 * - **Origin**, when present, must be a localhost origin. A page on the web
 *   POSTing here carries its own origin and is refused.
 * - **content-type must be JSON.** A cross-origin `fetch` with this type is not
 *   a CORS-simple request, so the browser preflights it — and we answer no CORS
 *   headers, so it never leaves. An HTML `<form>`, which needs no preflight,
 *   cannot produce this type at all.
 *
 * Returns an error string, or null when the write may proceed.
 */
export function writeRefusal(
	request: Request,
	options: { readOnly: boolean; blacklistError: string | null }
): string | null {
	if (options.readOnly) {
		return 'the viewer was started with --read-only; blacklist edits are disabled';
	}
	if (options.blacklistError !== null) {
		// Writing would serialize our empty in-memory fallback OVER whatever is in
		// the file, destroying verdicts we could not parse. Refuse and say why.
		return `refusing to write over an unreadable blacklist: ${options.blacklistError}`;
	}
	const origin = request.headers.get('origin');
	if (origin !== null && origin !== '' && origin !== 'null') {
		let host: string;
		try {
			host = new URL(origin).hostname;
		} catch {
			return `cross-origin write refused (origin: ${origin})`;
		}
		if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
			return `cross-origin write refused (origin: ${origin})`;
		}
	}
	const bodyType = request.headers.get('content-type') ?? '';
	if (!bodyType.toLowerCase().startsWith('application/json')) {
		return 'blacklist edits must be sent as application/json';
	}
	return null;
}

/** Shape of an add/remove request body, validated before anything is written. */
export interface BlacklistWriteBody {
	model?: unknown;
	effort?: unknown;
	backend?: unknown;
	reason?: unknown;
	evidence?: unknown;
}

export type ParsedWrite =
	| { ok: true; entry: { model: string; effort?: string; backend?: string } }
	| { ok: false; error: string };

/** The scope fields common to add and remove. */
export function parseScope(body: BlacklistWriteBody): ParsedWrite {
	const text = (value: unknown): string | undefined =>
		typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

	const model = text(body.model);
	if (model === undefined) return { ok: false, error: 'model is required' };

	const backend = text(body.backend);
	if (backend !== undefined && backend !== 'openrouter' && backend !== 'claude') {
		return { ok: false, error: `backend must be openrouter|claude (got ${backend})` };
	}

	// An omitted/'*' effort means "every level" — kept as undefined so the entry
	// written here is byte-identical to one the CLI would write for that scope.
	const rawEffort = text(body.effort);
	const effort = rawEffort === undefined || rawEffort === '*' ? undefined : rawEffort;

	return { ok: true, entry: { model, effort, backend } };
}

/**
 * Add (`POST`) or drop (`DELETE`) one blacklist entry.
 *
 * Both go through `addEntry`/`removeEntries` from the CLI module, so an entry
 * recorded here is indistinguishable from one `bench:blacklist --add` wrote —
 * same duplicate-scope refusal, same file shape, same `added` stamp. The reply
 * carries the refreshed list so the UI updates from the server's truth rather
 * than from an optimistic guess about what it just did.
 */
async function handleBlacklistWrite(
	request: Request,
	args: ViewerArgs,
	blacklistCache: BlacklistCache,
	indexCache: IndexCache
): Promise<Response> {
	if (request.method !== 'POST' && request.method !== 'DELETE') {
		return json({ error: `${request.method} not allowed on /api/blacklist` }, 405);
	}

	// Cheap refusals first, off the cached read — no reason to buffer a body we
	// are going to reject for being read-only or cross-origin.
	const refusal = writeRefusal(request, {
		readOnly: args.readOnly,
		blacklistError: blacklistCache.get().error
	});
	if (refusal !== null) return json({ error: refusal }, 403);

	let body: BlacklistWriteBody;
	try {
		body = (await request.json()) as BlacklistWriteBody;
	} catch {
		return json({ error: 'body must be valid JSON' }, 400);
	}
	if (typeof body !== 'object' || body === null) {
		return json({ error: 'body must be a JSON object' }, 400);
	}

	const scope = parseScope(body);
	if (!scope.ok) return json({ error: scope.error }, 400);

	/**
	 * Everything from here to `saveBlacklist` is SYNCHRONOUS, over a FRESH read.
	 * Both properties are load-bearing and neither is incidental:
	 *
	 * - **Fresh**, because the cached copy is up to 2s stale and this is a
	 *   read-modify-write of the whole file. Serializing a 2-second-old snapshot
	 *   silently deletes any verdict `bench:blacklist --add` recorded in another
	 *   terminal in the meantime — the very workflow the cache TTL exists to
	 *   support — and reports success while doing it.
	 * - **Synchronous**, because an `await` between the read and the write is a
	 *   window for a second request to interleave. Two concurrent POSTs with slow
	 *   bodies both returned 200 with an `added` payload while only the later
	 *   entry reached disk. With no await in the critical section the event loop
	 *   cannot interleave, so no lock is needed.
	 */
	const fresh = loadBlacklistSafe(args.blacklistPath);
	if (fresh.error !== null) {
		// It parsed a moment ago and does not now: something else is mid-write, or
		// wrote garbage. Either way this request must not serialize over it.
		blacklistCache.invalidate();
		return json({ error: `refusing to write over an unreadable blacklist: ${fresh.error}` }, 409);
	}
	const blacklist = fresh.list;

	if (request.method === 'DELETE') {
		const { list: next, removed } = removeEntries(blacklist, scope.entry);
		if (removed.length === 0) {
			return json({ error: `no entry matching ${scope.entry.model}` }, 404);
		}
		saveBlacklist(next, args.blacklistPath);
		blacklistCache.invalidate();
		return json({
			removed: removed.map((entry) => toInfo(entry)),
			...blacklistPayload(args, next, null, indexCache.get().runs)
		});
	}

	// A verdict without its why rots into superstition, so `reason` is required
	// here exactly as it is on the CLI — the UI cannot record a silent veto.
	const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
	if (reason.length === 0) {
		return json({ error: 'reason is required — a verdict without its why is unusable' }, 400);
	}
	const evidence =
		typeof body.evidence === 'string' && body.evidence.trim().length > 0
			? body.evidence.trim()
			: undefined;

	const entry: BlacklistEntry = { ...scope.entry, reason, added: today(), evidence };
	const result = addEntry(blacklist, entry);
	if (!result.ok) return json({ error: result.error }, 409);

	saveBlacklist(result.list, args.blacklistPath);
	blacklistCache.invalidate();
	return json({
		added: toInfo(entry),
		...blacklistPayload(args, result.list, null, indexCache.get().runs)
	});
}

export function createHandler(args: ViewerArgs, hasUi: boolean) {
	const cache = new IndexCache(args.runsDir);
	const blacklistCache = new BlacklistCache(args.blacklistPath);

	/**
	 * Every request goes through this, so an unexpected throw becomes a small JSON
	 * error instead of Bun's fallback page — which is 67 KB of SOURCE LINES and
	 * absolute filesystem paths. `report.json` and `manifest.json` are read
	 * unvalidated, so a schema-drifted file really can throw deep inside a
	 * derivation, and one bad run must not take the endpoint (or leak the repo).
	 */
	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const { pathname } = url;

		if (!isAllowedHost(request.headers.get('host'))) {
			return new Response('forbidden: this server only answers to localhost\n', {
				status: 403,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		if (pathname === '/api/blacklist' && request.method !== 'GET') {
			return handleBlacklistWrite(request, args, blacklistCache, cache);
		}

		if (pathname.startsWith('/api/')) {
			const index = cache.get();
			const { list: blacklist, error: blacklistError } = blacklistCache.get();
			const matching = filterRuns(index.runs, filterFromQuery(url));
			// Blacklist hiding runs LAST, after every other filter, so the count it
			// reports is "hidden from this slice" rather than "hidden from the corpus".
			const includeBlacklisted = includeBlacklistedFromQuery(url);
			const runs = includeBlacklisted ? matching : hideBlacklisted(matching, blacklist);
			const hidden = matching.length - runs.length;

			switch (pathname) {
				case '/api/overview':
					return json(overview(index, args, blacklist, blacklistError));

				case '/api/blacklist':
					return json(blacklistPayload(args, blacklist, blacklistError, index.runs));

				/**
				 * What a proposed verdict would retire, before it is recorded. The
				 * blacklist's scope is (model, effort, backend) while the leaderboard
				 * splits rows on provenance and quantization too, so one verdict can
				 * cover several rows — the form shows this so nobody retires twice what
				 * they were looking at.
				 */
				case '/api/blacklist/scope': {
					const model = url.searchParams.get('model');
					if (!model) return json({ error: 'model is required' }, 400);
					const rawEffort = url.searchParams.get('effort');
					const rawBackend = url.searchParams.get('backend');
					return json(
						scopeCoverage(index.runs, {
							model,
							effort: rawEffort === null || rawEffort === '*' ? undefined : rawEffort,
							backend: rawBackend === null || rawBackend === '' ? undefined : rawBackend
						})
					);
				}

				/**
				 * How big the CURRENT slice is and how much of it the blacklist hid.
				 * The filter bar renders above every view and must state the narrowing
				 * IT performs; the corpus-wide count on `/api/overview` answers a
				 * different question and over-states whenever a filter is active.
				 */
				case '/api/slice':
					return json({
						n_matching: matching.length,
						n_visible: runs.length,
						hidden_blacklisted: hidden,
						/**
						 * Blacklisted runs in this slice, INDEPENDENT of the toggle —
						 * `hidden_blacklisted` is 0 by construction while they are shown, so
						 * the control would read "showing blacklisted (0 runs)". This is the
						 * number that means the same thing in both states.
						 */
						n_blacklisted: matching.length - hideBlacklisted(matching, blacklist).length,
						include_blacklisted: includeBlacklisted
					});

				case '/api/runs':
					return json({
						runs: runs.map((run) => {
							const block = blockFor(run, blacklist);
							return { ...runRow(run), blacklist: block === null ? null : toInfo(block) };
						}),
						hidden_blacklisted: hidden,
						include_blacklisted: includeBlacklisted
					});

				case '/api/cells': {
					const mode = parseMode(url.searchParams.get('mode'));
					const dimensions = parseDimensions(url.searchParams.get('dims'));
					const cells = buildCells(runs, { dimensions, mode });
					return json({
						mode,
						dimensions,
						hidden_blacklisted: hidden,
						include_blacklisted: includeBlacklisted,
						cells: cells.map((cell) => serializeCell(cell, blacklist))
					});
				}

				case '/api/discrimination': {
					const mode = parseMode(url.searchParams.get('mode'));
					const metric = parseMetric(url.searchParams.get('metric'));
					return json({
						metric,
						mode,
						hidden_blacklisted: hidden,
						tasks: taskDiscrimination(runs, metric, { mode })
					});
				}

				case '/api/run': {
					const id = url.searchParams.get('id');
					// Looked up in the FULL index, never the hidden slice: a deep link to a
					// retired run must open and say it is retired, not 404.
					const run = index.runs.find((entry) => entry.run_id === id);
					if (!run) return json({ error: `no such run: ${id}` }, 404);
					return json(runDetail(run, args.tasksDir, blacklist));
				}

				default:
					return json({ error: `no such endpoint: ${pathname}` }, 404);
			}
		}

		if (!hasUi) {
			return new Response('The viewer UI is not built. The JSON API is live at /api/overview.\n', {
				status: 503,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		// SPA: serve the asset when it exists, index.html otherwise so client-side
		// routes deep-link correctly.
		const assetPath = resolveAsset(DIST_DIR, pathname);
		if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
			return new Response(readFileSync(assetPath), {
				headers: { 'content-type': contentType(assetPath), 'cache-control': 'no-store' }
			});
		}
		const indexPath = join(DIST_DIR, 'index.html');
		if (!existsSync(indexPath)) return new Response('not found', { status: 404 });
		return new Response(readFileSync(indexPath), {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
		});
	};

	return async (request: Request): Promise<Response> => {
		try {
			return await handle(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`request failed: ${new URL(request.url).pathname}: ${message}`);
			return json({ error: message }, 500);
		}
	};
}

function main(argv: string[]): number {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		console.error(parsed.error);
		console.error(USAGE);
		return 2;
	}
	const { args } = parsed;

	const index = loadRunIndex(args.runsDir);
	if (index.runs.length === 0) {
		console.error(
			`no bench runs under ${args.runsDir}. bench/ is gitignored, so this is expected on a ` +
				'fresh clone — record a task and run bench:run to populate it.'
		);
	}
	for (const problem of index.problems) {
		console.error(`skipped ${problem.dir}: ${problem.error}`);
	}

	const { list: blacklist, error: blacklistError } = loadBlacklistSafe(args.blacklistPath);
	if (blacklistError !== null) {
		console.error(`blacklist unreadable (${args.blacklistPath}): ${blacklistError}`);
		console.error('  nothing will be hidden, and blacklist edits are disabled until it parses.');
	}

	const hasUi = ensureBuilt({ force: args.rebuild, enabled: args.build });

	Bun.serve({
		port: args.port,
		hostname: '127.0.0.1',
		fetch: createHandler(args, hasUi)
	});

	console.error(
		`bench viewer on http://127.0.0.1:${args.port} — ${index.runs.length} run(s) from ${args.runsDir}`
	);
	if (blacklistError === null) {
		const hiddenRuns = index.runs.length - hideBlacklisted(index.runs, blacklist).length;
		console.error(
			`blacklist: ${blacklist.entries.length} entr(y|ies) hiding ${hiddenRuns} run(s) by default ` +
				`— toggle "show blacklisted" in the UI. ` +
				(args.readOnly ? 'Edits DISABLED (--read-only).' : `Edits write ${args.blacklistPath}.`)
		);
	}
	return 0;
}

if (import.meta.main) {
	// A non-zero code is a startup failure; 0 means Bun.serve is now listening and
	// the process should stay up, so only failures exit.
	const code = main(process.argv.slice(2));
	if (code !== 0) process.exit(code);
}
