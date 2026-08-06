/**
 * Typed fetch helpers for the viewer API.
 *
 * Reads are plain GETs against the local `bench:viewer` server. The ONLY writes
 * in this app are the two blacklist calls at the bottom, and that boundary is
 * deliberate: the bench corpus is written by `bench:run` and the authoring tools
 * alone, because a dashboard that can edit its own evidence is a way to lose it.
 * The blacklist is not evidence — it is the git-tracked record of decisions made
 * FROM the evidence, and the screen where you read the numbers is the right
 * place to record the verdict they support.
 */
import type {
	AverageMode,
	BlacklistResponse,
	CellsResponse,
	MetricKey,
	Overview,
	RunDetail,
	RunsResponse,
	ScopeCoverage,
	SliceInfo,
	TaskDiscrimination
} from './types';

async function detailOf(response: Response): Promise<string> {
	let detail = `${response.status} ${response.statusText}`;
	try {
		const body = (await response.json()) as { error?: string };
		if (body.error) detail = body.error;
	} catch {
		// Non-JSON error body — the status line is all we have.
	}
	return detail;
}

async function get<T>(path: string): Promise<T> {
	const response = await fetch(path, { headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(await detailOf(response));
	return (await response.json()) as T;
}

async function send<T>(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		// This exact content type is load-bearing: it makes the request non-simple,
		// so a cross-origin caller is stopped by preflight before it reaches the
		// server's own origin check. The server refuses any other type.
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) throw new Error(await detailOf(response));
	return (await response.json()) as T;
}

function withQuery(path: string, query: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams(query);
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	const search = params.toString();
	return search ? `${path}?${search}` : path;
}

export function fetchRuns(query: string): Promise<RunsResponse> {
	return get<RunsResponse>(withQuery('/api/runs', query));
}

export function fetchCells(
	query: string,
	mode: AverageMode,
	dimensions: string[]
): Promise<CellsResponse> {
	const extra: Record<string, string> = { mode };
	if (dimensions.length > 0) extra.dims = dimensions.join(',');
	return get<CellsResponse>(withQuery('/api/cells', query, extra));
}

export async function fetchDiscrimination(
	query: string,
	mode: AverageMode,
	metric: MetricKey
): Promise<TaskDiscrimination[]> {
	const data = await get<{ tasks: TaskDiscrimination[] }>(
		withQuery('/api/discrimination', query, { mode, metric })
	);
	return data.tasks;
}

/** @param revision refresh key — see `fetchOverview`. Inert on the server. */
export function fetchRun(runId: string, revision = 0): Promise<RunDetail> {
	const rev = revision > 0 ? `&_rev=${encodeURIComponent(String(revision))}` : '';
	return get<RunDetail>(`/api/run?id=${encodeURIComponent(runId)}${rev}`);
}

/**
 * The overview payload, fetched at most once per page load.
 *
 * Several components need the facet lists; memoizing the promise means they can
 * each `await fetchOverview()` in a `$derived` without the shared state plumbing
 * — and without four components racing four identical requests.
 */
let overviewPromise: Promise<Overview> | null = null;
let overviewRevision = 0;

/**
 * @param revision Pass `filters.revision`. It is not sent to the server — it is
 * the MEMO KEY. A blacklist edit changes the entry list, the per-model states
 * and the hidden-run count without changing any filter, so the bumped revision
 * is what tells this cache (and the `$derived` reading it) that the answer moved.
 */
export function fetchOverview(revision = 0): Promise<Overview> {
	if (revision !== overviewRevision) {
		overviewRevision = revision;
		overviewPromise = null;
	}
	// A REJECTED promise must not be memoized: `??=` cached the failure forever,
	// so one transient 500 bricked the dashboard and the error boundary's "Try
	// again" re-awaited the same rejection without issuing a request.
	overviewPromise ??= get<Overview>('/api/overview').catch((error: unknown) => {
		overviewPromise = null;
		throw error;
	});
	return overviewPromise;
}

/**
 * Run detail, or null when no id is selected — keeps the guard out of the view.
 *
 * @param revision refresh key — see `fetchOverview`. A run's own blacklist badge
 * changes when a verdict is recorded from this very page, so the detail view has
 * to re-read on a bump like everything else.
 */
export function fetchRunOrNull(runId: string | null, revision = 0): Promise<RunDetail | null> {
	if (!runId) return Promise.resolve(null);
	return fetchRun(runId, revision);
}

/** Both sides of a comparison, or null until two runs are chosen. */
export function fetchRunPair(
	idA: string | null,
	idB: string | null
): Promise<[RunDetail, RunDetail] | null> {
	if (!idA || !idB) return Promise.resolve(null);
	return Promise.all([fetchRun(idA), fetchRun(idB)]);
}

// --- blacklist ----------------------------------------------------------------

/** @param revision memo/refresh key — see `fetchOverview`. Not sent as a filter. */
export function fetchBlacklist(revision = 0): Promise<BlacklistResponse> {
	return get<BlacklistResponse>(
		revision > 0 ? `/api/blacklist?_rev=${encodeURIComponent(String(revision))}` : '/api/blacklist'
	);
}

/**
 * How big the current slice is and how much of it the blacklist hid.
 *
 * The filter bar needs the SLICE count, not the corpus count: with a model
 * filter on a model that has no verdict against it, the corpus number would
 * claim 62 runs are hidden while the views show none.
 */
export function fetchSlice(query: string): Promise<SliceInfo> {
	return get<SliceInfo>(withQuery('/api/slice', query));
}

/** What a proposed verdict would retire — shown in the form before recording it. */
export function fetchScopeCoverage(scope: BlacklistScope): Promise<ScopeCoverage> {
	const params = new URLSearchParams({ model: scope.model });
	if (scope.effort !== undefined) params.set('effort', scope.effort);
	if (scope.backend !== undefined && scope.backend !== '') params.set('backend', scope.backend);
	return get<ScopeCoverage>(`/api/blacklist/scope?${params.toString()}`);
}

/** The scope a verdict covers. `effort: '*'` (or omitted) means every level. */
export interface BlacklistScope {
	model: string;
	effort?: string;
	backend?: string;
}

/**
 * Record a verdict. `reason` is required by the server, deliberately: a verdict
 * without its why rots into superstition, and the UI must not be an easier way
 * to record a silent veto than the CLI is.
 */
export async function addBlacklistEntry(
	scope: BlacklistScope & { reason: string; evidence?: string }
): Promise<BlacklistResponse> {
	return send<BlacklistResponse>('/api/blacklist', 'POST', scope);
}

/** Drop a verdict — models get updated, and a blacklist you cannot undo is a trap. */
export function removeBlacklistEntry(scope: BlacklistScope): Promise<BlacklistResponse> {
	return send<BlacklistResponse>('/api/blacklist', 'DELETE', scope);
}
