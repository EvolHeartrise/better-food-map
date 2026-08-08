/**
 * Typed fetch helpers for the viewer API.
 *
 * Strictly read-only: the bench corpus is written by `bench:run` and the
 * authoring tools alone, because a dashboard that can edit its own evidence is
 * a way to lose it. This app performs no writes at all.
 */
import type {
	AverageMode,
	CellsResponse,
	MetricKey,
	Overview,
	RunDetail,
	RunsResponse,
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

export function fetchRun(runId: string): Promise<RunDetail> {
	return get<RunDetail>(`/api/run?id=${encodeURIComponent(runId)}`);
}

/**
 * The overview payload, fetched at most once per page load.
 *
 * Several components need the facet lists; memoizing the promise means they can
 * each `await fetchOverview()` in a `$derived` without the shared state plumbing
 * — and without four components racing four identical requests.
 */
let overviewPromise: Promise<Overview> | null = null;

export function fetchOverview(): Promise<Overview> {
	// A REJECTED promise must not be memoized: `??=` cached the failure forever,
	// so one transient 500 bricked the dashboard and the error boundary's "Try
	// again" re-awaited the same rejection without issuing a request.
	overviewPromise ??= get<Overview>('/api/overview').catch((error: unknown) => {
		overviewPromise = null;
		throw error;
	});
	return overviewPromise;
}

/** Run detail, or null when no id is selected — keeps the guard out of the view. */
export function fetchRunOrNull(runId: string | null): Promise<RunDetail | null> {
	if (!runId) return Promise.resolve(null);
	return fetchRun(runId);
}

/** Both sides of a comparison, or null until two runs are chosen. */
export function fetchRunPair(
	idA: string | null,
	idB: string | null
): Promise<[RunDetail, RunDetail] | null> {
	if (!idA || !idB) return Promise.resolve(null);
	return Promise.all([fetchRun(idA), fetchRun(idB)]);
}

/** How big the current slice is — the filter bar states the narrowing it performs. */
export function fetchSlice(query: string): Promise<SliceInfo> {
	return get<SliceInfo>(withQuery('/api/slice', query));
}
