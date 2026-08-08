/**
 * Typed fetch helpers for the viewer API.
 *
 * Write policy — inputs, never evidence. The authoring calls at the bottom may
 * write bench INPUTS (task.json, gold files, review state) through
 * `/api/authoring/*`. Nothing here can touch `bench/runs`: a dashboard that
 * can edit its own evidence is a way to lose it, and that invariant survives
 * this app growing authoring tools.
 */
import type {
	AuthoringStatus,
	AuthoringTask,
	AverageMode,
	CellsResponse,
	CityRow,
	GoldItem,
	MetricKey,
	Overview,
	RunDetail,
	RunsResponse,
	SliceInfo,
	SourcesSummary,
	TaskDiscrimination,
	WriteResult
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

// --- authoring (writes bench INPUTS only — see the header) ----------------------

/**
 * POST that never throws on an application error: authoring failures (lint
 * errors on promote, validation issues on save) are outcomes the UI renders,
 * not exceptions for the boundary to swallow.
 */
async function post(path: string, body: unknown): Promise<WriteResult> {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	const parsed = (await response
		.json()
		.catch(() => ({ error: `${response.status} ${response.statusText}` }))) as Omit<
		WriteResult,
		'ok'
	>;
	return { ok: response.ok, ...parsed };
}

export function fetchAuthoringStatus(): Promise<AuthoringStatus> {
	return get<AuthoringStatus>('/api/authoring/status');
}

export function fetchAuthoringTask(slug: string, file?: 'draft' | 'data'): Promise<AuthoringTask> {
	const query = file ? `&file=${file}` : '';
	return get<AuthoringTask>(`/api/authoring/task?task=${encodeURIComponent(slug)}${query}`);
}

export function fetchAuthoringPage(
	slug: string,
	url: string
): Promise<{ url: string; text: string }> {
	return get<{ url: string; text: string }>(
		`/api/authoring/page?task=${encodeURIComponent(slug)}&url=${encodeURIComponent(url)}`
	);
}

export function saveGold(payload: {
	task: string;
	file: 'draft' | 'data';
	items: GoldItem[];
	sources: string[];
	reviewed: string[];
}): Promise<WriteResult> {
	return post('/api/authoring/save', payload);
}

export function promoteGold(task: string, policyVersion: string): Promise<WriteResult> {
	return post('/api/authoring/promote', { task, policy_version: policyVersion });
}

export function createAuthoringTask(payload: {
	slug: string;
	entry_url: string;
	stratum: string;
}): Promise<WriteResult> {
	return post('/api/authoring/create', payload);
}

export function claimAuthoringTask(payload: {
	slug: string;
	stratum: string;
}): Promise<WriteResult> {
	return post('/api/authoring/claim', payload);
}

// --- data-source metrics --------------------------------------------------------

export function fetchSourcesSummary(): Promise<SourcesSummary> {
	return get<SourcesSummary>('/api/sources/summary');
}

export function fetchSourceCities(region: string): Promise<{ region: string; cities: CityRow[] }> {
	return get<{ region: string; cities: CityRow[] }>(
		`/api/sources/cities?region=${encodeURIComponent(region)}`
	);
}
