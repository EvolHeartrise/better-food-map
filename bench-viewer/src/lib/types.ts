/**
 * Wire types for the viewer API.
 *
 * These mirror `scripts/bench/analyze/*` across the JSON boundary. Nulls are
 * load-bearing everywhere: a null is UNKNOWN (a field a run predates, a cost the
 * provider never reported), and the UI must render it as "—", never as 0.
 *
 * Mirroring by hand is a liability — nothing checks a mirror against what it
 * reflects, and one silently-drifted shape crashed the navigation tab on every
 * run. Where a server type is plain data with no server-only dependencies,
 * IMPORT it instead (see `PageCoverage`): `import type` is erased at build, so
 * it costs nothing and makes drift a compile error.
 */
import type { PageCoverage } from '../../../scripts/bench/analyze/transcript';

/**
 * IMPORTED, not mirrored — for the reason the header states, and because this
 * exact trio already drifted once. `Stat` used to be hand-written here with an
 * `approx?: boolean` flag; the aggregation renamed that field to `unpoolable`
 * when the "approximate" micro-average was measured to be wrong (see
 * `MICRO_EXACT` in analyze/aggregate.ts), and the mirror kept the dead name.
 * Both sides type-checked. The leaderboard's `{#if stat.approx}` badge simply
 * stopped firing, so a metric with NO micro value rendered as a bare em dash —
 * indistinguishable from "no data", which is the one conflation the aggregation
 * rules forbid.
 *
 * `MetricKey` and `AverageMode` come along because they are the same kind of
 * thing: plain string unions owned by the aggregation, with no server-only
 * dependencies. `import type` is erased at build, so this costs nothing at
 * runtime and makes the next rename a compile error here.
 */
import type { AverageMode, MetricKey, Stat } from '../../../scripts/bench/analyze/aggregate';

// Imported for use below AND re-exported, since the rest of the app reads these
// three from `lib/types` alongside the hand-written wire shapes.
export type { AverageMode, MetricKey, Stat };

/** Size of the current filter slice. */
export interface SliceInfo {
	n_matching: number;
	n_visible: number;
}

export interface Overview {
	runs_dir: string;
	tasks_dir: string;
	counts: { runs: number; scored: number; failed: number; tasks: number; models: number };
	facets: {
		tasks: string[];
		models: string[];
		backends: string[];
		efforts: string[];
		policy_versions: string[];
		metrics: MetricKey[];
		dimensions: string[];
	};
	problems: { dir: string; error: string }[];
	unattributed_runs: number;
}

/**
 * One row of the flattened run index (`runRow` in analyze/export.ts). The CSV
 * export stays flat scalars; this type is the API's shape, not the file's.
 */
export interface RunRow {
	run_id: string;
	task: string;
	model: string;
	backend: string;
	effort: string | null;
	effort_default: string | null;
	temperature: number | null;
	quantization_requested: string | null;
	provenance: string;
	rerouted: number;
	/** Agent setup. Pre-harness runs read `single-pass` — what they in fact were. */
	harness: string;
	/** `none` (no review pass), `same` (reviewer inherited), or the override. */
	review: string;
	/** Joined per-pass prompt hashes, or `unknown` on a run predating hashing. */
	prompt_sha: string;
	/** Passes recorded; 0 on runs predating multi-pass harnesses. */
	n_passes: number;
	policy_version: string | null;
	status: 'scored' | 'failed';
	failure_reason: string | null;
	started_at: string;
	duration_ms: number | null;
	wall_clock_ms: number | null;
	bench_overhead_ms: number | null;
	tool_calls: number | null;
	submit_attempts: number | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	cached_prompt_tokens: number | null;
	cache_hit_rate: number | null;
	output_tok_per_s: number | null;
	cost_usd: number | null;
	cost_source: string | null;
	price_cached: number | null;
	unsafe_tag_claims: number | null;
	gold_items: number | null;
	candidate_items: number | null;
	matched: number | null;
	item_recall: number | null;
	item_precision: number | null;
	tag_precision: number | null;
	tag_recall: number | null;
	optional_tag_precision: number | null;
	optional_tag_recall: number | null;
	price_accuracy: number | null;
	description_accuracy: number | null;
	warning_accuracy: number | null;
	source_recall: number | null;
	source_precision: number | null;
}

export interface CellRow {
	key: string;
	model: string;
	backend: string;
	effort: string;
	quantization?: string;
	provenance?: string;
	/** Present when `harness` is among the active dimensions (it is by default). */
	harness?: string;
	review?: string;
	prompt_sha?: string;
	task?: string;
	policy_version?: string;
	n_runs: number;
	n_scored: number;
	n_failed: number;
	failure_rate: number;
	tasks: string;
	n_tasks: number;
	scored_tasks: string;
	/** Tasks that produced a score — the only honest basis for a coverage claim. */
	n_scored_tasks: number;
	/** Runs whose provider was never recorded, so their score is unattributable. */
	unattributed_runs: number;
	policy_versions: string;
	policy_conflict_tasks: string;
	policy_conflicts: { task: string; versions: string[] }[];
	provenances: string[];
	mixed_provenance: number;
	rerouted: number;
	unsafe_tag_claims_total: number;
	run_ids: string[];
	metrics: Record<MetricKey, Stat>;
	stats: {
		cost_usd: Stat;
		price_cached: Stat;
		duration_ms: Stat;
		total_tokens: Stat;
		cache_hit_rate: Stat;
		output_tok_per_s: Stat;
		unsafe_tag_claims: Stat;
	};
}

export interface CellsResponse {
	mode: AverageMode;
	dimensions: string[];
	cells: CellRow[];
}

export interface RunsResponse {
	runs: RunRow[];
}

export interface TaskDiscrimination {
	task: string;
	metric: MetricKey;
	n_cells: number;
	/** Cells that produced a score — every statistic below is over these. */
	n_scored_cells: number;
	sd: number | null;
	range: number | null;
	best: number | null;
	worst: number | null;
	ceiling_share: number | null;
}

export interface NameFidelity {
	renamed: { gold: string; candidate: string; distance: number; ratio: number }[];
	true_misses: string[];
	true_hallucinations: string[];
}

export interface MenuItem {
	name: string;
	description: string | null;
	tags: string[];
	optional_tags: string[];
	price: number | null;
	warning?: string | null;
}

export interface ScoreReport {
	gold_items: number;
	candidate_items: number;
	matched: number;
	item_recall: number;
	item_precision: number;
	missed_items: string[];
	hallucinated_items: string[];
	tag_precision: number;
	tag_recall: number;
	optional_tag_precision: number;
	optional_tag_recall: number;
	tag_false_positives: { item: string; tag: string; implied_by?: string }[];
	price_accuracy: number;
	price_mismatches?: { item: string; gold: number | null; candidate: number | null }[];
	description_accuracy: number;
	description_mismatches?: { item: string; gold: string | null; candidate: string | null }[];
	warning_accuracy: number;
	missing_warnings: string[];
	spurious_warnings: string[];
	source_recall: number;
	source_precision: number;
	ignored_sources: string[];
}

/** One pass of a multi-pass run, as recorded on `meta.passes`. */
export interface PassRow {
	index: number;
	role: string;
	model: string;
	backend: string;
	effort: string | null;
	/** Null when the pass recorded no status — never assumed to be `scored`. */
	status: string | null;
	failure_reason: string | null;
	duration_ms: number | null;
	tool_calls: number | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	price: number | null;
}

/**
 * The review pass's per-metric effect, computed from the two FROZEN reports.
 *
 * Deliberately a vector with no summary verdict: a reviewer that recovers a
 * missed page while renaming three items has improved recall AND damaged
 * precision, and one "improved/regressed" badge would erase the trade.
 */
export interface ReviewEffect {
	metrics: Partial<Record<MetricKey, { before: number; after: number; delta: number }>>;
	matched: { before: number; after: number };
	hallucinated: { before: number; after: number };
	/** Gold items pass 1 missed that the review pass found. */
	newly_found: string[];
	/** Gold items pass 1 had that the review pass lost — the regression to watch. */
	newly_missed: string[];
}

export interface RunDetail {
	run: {
		run_id: string;
		task: string;
		dir: string;
		model: string;
		backend: string;
		effort: string | null;
		effort_default: string | null;
		temperature: number | null;
		quantization_requested: string[] | null;
		providers: string[] | null;
		provider_quantizations: Record<string, string> | null;
		harness: string;
		prompt_sha: Record<string, string> | null;
		review_model: string | null;
		review_effort: string | null;
		passes: PassRow[];
		policy_version: string | null;
		entry_url: string | null;
		status: 'scored' | 'failed';
		failure_reason: string | null;
		started_at: string;
		duration_ms: number | null;
		wall_clock_ms: number | null;
		tool_calls: number | null;
		submit_attempts: number | null;
		prompt_tokens: number | null;
		completion_tokens: number | null;
		total_tokens: number | null;
		cached_prompt_tokens: number | null;
		cache_write_tokens: number | null;
		price: number | null;
		price_cached: number | null;
		total_cost_usd: number | null;
		report: ScoreReport | null;
		/** The FIRST pass's frozen report; null on a single-pass run. */
		report_pass1: ScoreReport | null;
	};
	/**
	 * What the review pass changed, or null when the run had one pass. Null is
	 * "no second pass", NOT "the second pass changed nothing" — that is a run
	 * whose deltas are all zero, and the UI must not render them the same way.
	 */
	review_effect: ReviewEffect | null;
	/**
	 * Page-discovery coverage per pass. Empty on a single-pass run or a transcript
	 * predating pass stamps; `page_coverage` above stays the whole-run union.
	 */
	pass_coverage: { pass: number; fetched_urls: string[]; coverage: PageCoverage | null }[];
	derived: {
		cost_usd: number | null;
		cost_source: string | null;
		cache_hit_rate: number | null;
		output_tok_per_s: number | null;
		bench_overhead_ms: number | null;
		unsafe_tag_claims: number | null;
		rerouted: boolean;
		provenance: string;
	};
	/** Overlay for the report AS SCORED at run time. */
	name_fidelity: NameFidelity | null;
	/** Overlay for the same submission against CURRENT gold; null when unavailable. */
	name_fidelity_current: NameFidelity | null;
	rescore: {
		run_id: string;
		as_scored: ScoreReport | null;
		current: ScoreReport | null;
		run_policy_version: string | null;
		current_policy_version: string | null;
		changed: boolean;
		error?: string;
	};
	/**
	 * IMPORTED from the server rather than mirrored by hand.
	 *
	 * Every other type in this file is a hand-written mirror, and nothing checks a
	 * mirror against the thing it reflects: when `pageCoverage` dropped its
	 * `menu_available` / `menu_visited` / `menu_ratio` / `menu_unvisited` fields
	 * (the menu-page ratio was removed as unsound), this declaration kept them and
	 * the navigation tab crashed on EVERY run with "can't access property length,
	 * page_coverage.menu_unvisited is undefined". Both sides type-checked; they
	 * simply described different objects.
	 *
	 * `PageCoverage` is plain data with no server-only dependencies, so importing
	 * it costs nothing at runtime (`import type` is erased) and makes that drift
	 * impossible rather than merely tested-for.
	 */
	page_coverage: PageCoverage | null;
	fetched_urls: string[];
	timeline: {
		type: string;
		ts: string;
		delta_ms: number | null;
		tool?: string;
		url?: string;
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		reasoning_tokens?: number;
		cost?: number;
		provider?: string;
		response_id?: string;
	}[];
	gold_items: MenuItem[] | null;
	candidate_items: MenuItem[] | null;
}

/** One plotted configuration in the frontier scatter. */
export interface ScatterPoint {
	id: string;
	label: string;
	x: number;
	y: number;
	n: number;
	frontier: boolean;
	detail?: string;
	/** Model author's favicon; null falls back to the plain circle mark. */
	icon?: string | null;
	/** Serving provider's favicon, badged on the mark's corner when known. */
	providerIcon?: string | null;
}
