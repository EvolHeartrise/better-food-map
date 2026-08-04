/**
 * Typed fetch helpers for the viewer API.
 *
 * Every call is a plain GET against the local `bench:viewer` server; there are no
 * mutations anywhere in this app by design — the bench corpus is written only by
 * `bench:run` and the authoring tools, and a dashboard that could edit it would
 * be a way to lose evidence.
 */
import type {
	AverageMode,
	CellsResponse,
	MetricKey,
	Overview,
	RunDetail,
	RunRow,
	TaskDiscrimination
} from './types';

async function get<T>(path: string): Promise<T> {
	const response = await fetch(path, { headers: { accept: 'application/json' } });
	if (!response.ok) {
		let detail = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) detail = body.error;
		} catch {
			// Non-JSON error body — the status line is all we have.
		}
		throw new Error(detail);
	}
	return (await response.json()) as T;
}

function withQuery(path: string, query: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams(query);
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	const search = params.toString();
	return search ? `${path}?${search}` : path;
}

export async function fetchRuns(query: string): Promise<RunRow[]> {
	const data = await get<{ runs: RunRow[] }>(withQuery('/api/runs', query));
	return data.runs;
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
