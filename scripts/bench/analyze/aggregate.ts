/**
 * Cross-run aggregation: config cells, averaging modes, spread, frontiers.
 *
 * Three deliberate constraints, each inherited from how the bench itself is
 * specified:
 *
 * - **No composite score.** The scorer keeps recall and precision apart on
 *   purpose ("a hallucinated free-of tag is a safety problem; a missed tag is a
 *   completeness problem"), so nothing here averages them into one number. Cells
 *   expose the vector; ranking is by whichever column the caller sorts on.
 * - **Averaging mode is explicit.** Macro gives every task equal weight; micro
 *   pools raw counts, so a 180-item task outweighs a 26-item one. Neither is
 *   "the" answer, so the caller always names one and the mode travels with the
 *   result.
 * - **Provenance splits cells by default.** Aggregating a run served at fp4 with
 *   one served at fp8 measures neither endpoint.
 */
import type { ScoreReport } from '../score';
import { deriveRun, provenanceLabel } from './derive';
import type { RunRecord } from './record';

/** Report fields that are ratios in [0,1] and therefore aggregatable. */
export const METRIC_KEYS = [
	'item_recall',
	'item_precision',
	'tag_precision',
	'tag_recall',
	'optional_tag_precision',
	'optional_tag_recall',
	'price_accuracy',
	'description_accuracy',
	'warning_accuracy',
	'source_recall',
	'source_precision'
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export type AverageMode = 'macro' | 'micro';

/**
 * Which metrics micro-average EXACTLY, from the counts the report carries.
 *
 * `item_recall`/`item_precision` are reconstructible (matched / gold_items /
 * candidate_items are all reported). The per-pair accuracies are means over
 * `matched` pairs, so weighting by `matched` reproduces the pooled mean exactly.
 * The tag metrics are the gap: the report publishes the ratios but not their tag
 * denominators, so pooling them is a `matched`-weighted APPROXIMATION and is
 * flagged as such rather than presented as a pooled truth.
 */
const MICRO_EXACT: ReadonlySet<MetricKey> = new Set<MetricKey>([
	'item_recall',
	'item_precision',
	'price_accuracy',
	'description_accuracy',
	'warning_accuracy'
]);

export interface Stat {
	/** Aggregate value under the requested mode. Null when nothing contributed. */
	mean: number | null;
	/** Sample standard deviation of the per-run values. Null when n < 2. */
	sd: number | null;
	median: number | null;
	min: number | null;
	max: number | null;
	/** Runs that contributed a value. */
	n: number;
	/**
	 * Set when the mean is a weighted approximation rather than a true pooled
	 * ratio (micro mode, tag/source metrics). Never set in macro mode.
	 */
	approx?: boolean;
}

const EMPTY_STAT: Stat = { mean: null, sd: null, median: null, min: null, max: null, n: 0 };

// --- basic statistics ---------------------------------------------------------

export function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample (n-1) standard deviation — these are samples of a model's behaviour, not a population. */
export function stdev(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const m = mean(values) as number;
	const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Spread stats over raw values — mode-independent, so callers can overwrite `mean`. */
export function describe(values: readonly number[]): Stat {
	if (values.length === 0) return { ...EMPTY_STAT };
	return {
		mean: mean(values),
		sd: stdev(values),
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
		n: values.length
	};
}

// --- metric aggregation -------------------------------------------------------

function metricValue(report: ScoreReport, key: MetricKey): number | null {
	const value = report[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scoredReports(runs: readonly RunRecord[]): { run: RunRecord; report: ScoreReport }[] {
	return runs
		.filter((run) => run.report !== null)
		.map((run) => ({ run, report: run.report as ScoreReport }));
}

/**
 * Aggregate one metric over a set of runs.
 *
 * Macro: mean per task, then mean of task means — so a cell that ran one task
 * ten times and another once doesn't let the first task dictate the number.
 * Micro: pooled over raw counts where the report supports it (see MICRO_EXACT),
 * `matched`-weighted otherwise and flagged `approx`.
 */
export function aggregateMetric(
	runs: readonly RunRecord[],
	key: MetricKey,
	mode: AverageMode
): Stat {
	const entries = scoredReports(runs).filter(({ report }) => metricValue(report, key) !== null);
	if (entries.length === 0) return { ...EMPTY_STAT };

	const values = entries.map(({ report }) => metricValue(report, key) as number);
	const stat = describe(values);

	if (mode === 'macro') {
		const byTask = new Map<string, number[]>();
		for (const { run, report } of entries) {
			const list = byTask.get(run.task) ?? [];
			list.push(metricValue(report, key) as number);
			byTask.set(run.task, list);
		}
		const taskMeans = [...byTask.values()].map((list) => mean(list) as number);
		stat.mean = mean(taskMeans);
		return stat;
	}

	// micro
	if (key === 'item_recall' || key === 'item_precision') {
		const denomKey = key === 'item_recall' ? 'gold_items' : 'candidate_items';
		let matched = 0;
		let denom = 0;
		for (const { report } of entries) {
			matched += report.matched ?? 0;
			denom += report[denomKey] ?? 0;
		}
		// 0/0 is a perfect ratio here for the same reason the scorer says so:
		// nothing was asserted, so nothing is missing or wrong.
		stat.mean = denom === 0 ? 1 : matched / denom;
		return stat;
	}

	let weighted = 0;
	let weight = 0;
	for (const { report } of entries) {
		const w = report.matched ?? 0;
		weighted += (metricValue(report, key) as number) * w;
		weight += w;
	}
	stat.mean = weight === 0 ? null : weighted / weight;
	if (!MICRO_EXACT.has(key)) stat.approx = true;
	return stat;
}

// --- cells --------------------------------------------------------------------

export const DIMENSIONS = [
	'model',
	'backend',
	'effort',
	'temperature',
	'quantization',
	'provenance',
	'task',
	'policy_version'
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Default grouping. `provenance` is in by default on purpose: OpenRouter routes
 * to endpoints that differ in quantization, so merging them would report a
 * number that describes no actual endpoint.
 */
export const DEFAULT_DIMENSIONS: Dimension[] = [
	'model',
	'backend',
	'effort',
	'quantization',
	'provenance'
];

/** The display value of one dimension for one run. Never blank. */
export function dimensionValue(run: RunRecord, dimension: Dimension): string {
	switch (dimension) {
		case 'model':
			return run.model;
		case 'backend':
			return run.backend;
		case 'effort':
			// "no --effort passed" is a distinct configuration from any named level
			// (the blacklist makes the same distinction), so it gets its own label.
			return run.effort ?? `default(${run.effort_default ?? 'unknown'})`;
		case 'temperature':
			return run.temperature === null ? 'unset' : String(run.temperature);
		case 'quantization':
			return run.quantization_requested && run.quantization_requested.length > 0
				? run.quantization_requested.join('+')
				: 'unpinned';
		case 'provenance':
			return provenanceLabel(run);
		case 'task':
			return run.task;
		case 'policy_version':
			return run.policy_version ?? 'unknown';
	}
}

export interface Cell {
	/** Stable identity: the dimension values joined. */
	key: string;
	/** Dimension → value, for display and re-filtering. */
	dims: Record<string, string>;
	runs: RunRecord[];
	n_runs: number;
	n_scored: number;
	n_failed: number;
	/** Tasks this cell covers, sorted. A cell covering fewer tasks is less comparable. */
	tasks: string[];
	/** Distinct gold policy versions among the runs, for display. */
	policy_versions: string[];
	/**
	 * Tasks where the cell's runs were scored against DIFFERENT gold versions —
	 * the only policy mixing that actually breaks comparability.
	 *
	 * Note a cell spanning several tasks naturally shows several policy versions,
	 * because each task's gold carries its own: that is not a conflict. A conflict
	 * is two versions of the SAME task's gold, which means `report.json` snapshots
	 * from before and after a gold edit are being averaged together.
	 */
	policy_conflicts: { task: string; versions: string[] }[];
	/** Distinct provenance labels. More than one means mixed routing. */
	provenances: string[];
	/** True when any run in the cell was re-routed mid-flight. */
	rerouted: boolean;
	metrics: Record<MetricKey, Stat>;
	cost_usd: Stat;
	/** Counterfactual cost under perfect prefix caching (openrouter runs only). */
	price_cached: Stat;
	duration_ms: Stat;
	total_tokens: Stat;
	completion_tokens: Stat;
	cache_hit_rate: Stat;
	output_tok_per_s: Stat;
	/** Dangerous free-of/dietary claims gold does not support, summed over runs. */
	unsafe_tag_claims_total: number;
	unsafe_tag_claims: Stat;
	/** Failed runs as a share of all runs in the cell. */
	failure_rate: number;
}

function nonNull(values: readonly (number | null)[]): number[] {
	return values.filter((value): value is number => value !== null);
}

/** Tasks whose runs in this cell span more than one gold policy version. */
function policyConflicts(runs: readonly RunRecord[]): { task: string; versions: string[] }[] {
	const byTask = new Map<string, Set<string>>();
	for (const run of runs) {
		const versions = byTask.get(run.task) ?? new Set<string>();
		versions.add(run.policy_version ?? 'unknown');
		byTask.set(run.task, versions);
	}
	return [...byTask.entries()]
		.filter(([, versions]) => versions.size > 1)
		.map(([task, versions]) => ({ task, versions: [...versions].toSorted() }))
		.toSorted((a, b) => a.task.localeCompare(b.task));
}

/** Group runs into config cells and aggregate each. */
export function buildCells(
	runs: readonly RunRecord[],
	options?: { dimensions?: Dimension[]; mode?: AverageMode }
): Cell[] {
	const dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;
	const mode = options?.mode ?? 'macro';

	const groups = new Map<string, RunRecord[]>();
	for (const run of runs) {
		const key = dimensions.map((dimension) => dimensionValue(run, dimension)).join(' | ');
		const list = groups.get(key) ?? [];
		list.push(run);
		groups.set(key, list);
	}

	const cells: Cell[] = [];
	for (const [key, cellRuns] of groups) {
		const derived = cellRuns.map((run) => deriveRun(run));
		const metrics = {} as Record<MetricKey, Stat>;
		for (const metric of METRIC_KEYS) {
			metrics[metric] = aggregateMetric(cellRuns, metric, mode);
		}
		const nFailed = cellRuns.filter((run) => run.status === 'failed').length;

		cells.push({
			key,
			dims: Object.fromEntries(
				dimensions.map((dimension) => [dimension, dimensionValue(cellRuns[0], dimension)])
			),
			runs: cellRuns,
			n_runs: cellRuns.length,
			n_scored: cellRuns.length - nFailed,
			n_failed: nFailed,
			tasks: [...new Set(cellRuns.map((run) => run.task))].toSorted(),
			policy_versions: [
				...new Set(cellRuns.map((run) => run.policy_version ?? 'unknown'))
			].toSorted(),
			policy_conflicts: policyConflicts(cellRuns),
			provenances: [...new Set(derived.map((d) => d.provenance))].toSorted(),
			rerouted: derived.some((d) => d.rerouted),
			metrics,
			cost_usd: describe(nonNull(derived.map((d) => d.cost_usd))),
			price_cached: describe(nonNull(cellRuns.map((run) => run.price_cached))),
			duration_ms: describe(nonNull(cellRuns.map((run) => run.duration_ms))),
			total_tokens: describe(nonNull(cellRuns.map((run) => run.total_tokens))),
			completion_tokens: describe(nonNull(cellRuns.map((run) => run.completion_tokens))),
			cache_hit_rate: describe(nonNull(derived.map((d) => d.cache_hit_rate))),
			output_tok_per_s: describe(nonNull(derived.map((d) => d.output_tok_per_s))),
			unsafe_tag_claims_total: derived.reduce((sum, d) => sum + (d.unsafe_tag_claims ?? 0), 0),
			unsafe_tag_claims: describe(nonNull(derived.map((d) => d.unsafe_tag_claims))),
			failure_rate: cellRuns.length === 0 ? 0 : nFailed / cellRuns.length
		});
	}

	return cells.toSorted((a, b) => a.key.localeCompare(b.key));
}

// --- frontier -----------------------------------------------------------------

export interface FrontierPoint<T> {
	item: T;
	/** Minimized axis (cost, latency). */
	x: number;
	/** Maximized axis (a quality metric). */
	y: number;
}

/**
 * Pareto frontier: points no other point beats on BOTH axes (cheaper/faster and
 * better). Ties are kept — two configs at identical (x, y) are equally optimal
 * and dropping one would silently pick a winner.
 */
export function paretoFrontier<T>(points: readonly FrontierPoint<T>[]): FrontierPoint<T>[] {
	return points.filter(
		(point) =>
			!points.some(
				(other) =>
					other !== point &&
					other.x <= point.x &&
					other.y >= point.y &&
					(other.x < point.x || other.y > point.y)
			)
	);
}

// --- task discrimination ------------------------------------------------------

export interface TaskDiscrimination {
	task: string;
	metric: MetricKey;
	/** Distinct config cells that ran this task. */
	n_cells: number;
	/** Spread of cell means — the task's power to separate configurations. */
	sd: number | null;
	range: number | null;
	best: number | null;
	worst: number | null;
	/** Share of cells scoring >= 0.999 — a task at ceiling has stopped discriminating. */
	ceiling_share: number | null;
}

/**
 * How well each task still separates configurations.
 *
 * A task every model aces has stopped paying for itself, and the bench's own
 * history says this happens fast (namdharirestaurant went to ceiling for
 * frontier models within a day of being authored). This is the signal for where
 * to record the next venue.
 */
export function taskDiscrimination(
	runs: readonly RunRecord[],
	metric: MetricKey,
	options?: { dimensions?: Dimension[]; mode?: AverageMode }
): TaskDiscrimination[] {
	const tasks = [...new Set(runs.map((run) => run.task))].toSorted();
	return tasks.map((task) => {
		const taskRuns = runs.filter((run) => run.task === task);
		const cells = buildCells(taskRuns, options);
		const means = cells
			.map((cell) => cell.metrics[metric].mean)
			.filter((value): value is number => value !== null);
		return {
			task,
			metric,
			n_cells: cells.length,
			sd: stdev(means),
			range: means.length === 0 ? null : Math.max(...means) - Math.min(...means),
			best: means.length === 0 ? null : Math.max(...means),
			worst: means.length === 0 ? null : Math.min(...means),
			ceiling_share:
				means.length === 0 ? null : means.filter((value) => value >= 0.999).length / means.length
		};
	});
}

// --- filtering ----------------------------------------------------------------

export interface RunFilter {
	tasks?: string[];
	models?: string[];
	backends?: string[];
	efforts?: string[];
	policyVersions?: string[];
	/** Include failed runs. Default true — a failure rate you can't see is a lie. */
	includeFailed?: boolean;
	/** ISO instants bounding `started_at`. */
	since?: string;
	until?: string;
}

export function filterRuns(runs: readonly RunRecord[], filter: RunFilter): RunRecord[] {
	return runs.filter((run) => {
		if (filter.tasks?.length && !filter.tasks.includes(run.task)) return false;
		if (filter.models?.length && !filter.models.includes(run.model)) return false;
		if (filter.backends?.length && !filter.backends.includes(run.backend)) return false;
		if (filter.efforts?.length && !filter.efforts.includes(dimensionValue(run, 'effort'))) {
			return false;
		}
		if (
			filter.policyVersions?.length &&
			!filter.policyVersions.includes(run.policy_version ?? 'unknown')
		) {
			return false;
		}
		if (filter.includeFailed === false && run.status === 'failed') return false;
		if (filter.since && run.started_at < filter.since) return false;
		if (filter.until && run.started_at > filter.until) return false;
		return true;
	});
}
