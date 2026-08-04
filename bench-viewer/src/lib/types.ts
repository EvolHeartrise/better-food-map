/**
 * Wire types for the viewer API.
 *
 * These mirror `scripts/bench/analyze/*` across the JSON boundary. Nulls are
 * load-bearing everywhere: a null is UNKNOWN (a field a run predates, a cost the
 * provider never reported), and the UI must render it as "—", never as 0.
 */

export interface Stat {
	mean: number | null;
	sd: number | null;
	median: number | null;
	min: number | null;
	max: number | null;
	n: number;
	approx?: boolean;
}

export type MetricKey =
	| 'item_recall'
	| 'item_precision'
	| 'tag_precision'
	| 'tag_recall'
	| 'optional_tag_precision'
	| 'optional_tag_recall'
	| 'price_accuracy'
	| 'description_accuracy'
	| 'warning_accuracy'
	| 'source_recall'
	| 'source_precision';

export type AverageMode = 'macro' | 'micro';

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

/** One row of the flattened run index (`runRow` in analyze/export.ts). */
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
	task?: string;
	policy_version?: string;
	n_runs: number;
	n_scored: number;
	n_failed: number;
	failure_rate: number;
	tasks: string;
	n_tasks: number;
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

export interface TaskDiscrimination {
	task: string;
	metric: MetricKey;
	n_cells: number;
	sd: number | null;
	range: number | null;
	best: number | null;
	worst: number | null;
	ceiling_share: number | null;
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
	};
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
	name_fidelity: {
		renamed: { gold: string; candidate: string; distance: number; ratio: number }[];
		true_misses: string[];
		true_hallucinations: string[];
	} | null;
	rescore: {
		run_id: string;
		as_scored: ScoreReport | null;
		current: ScoreReport | null;
		run_policy_version: string | null;
		current_policy_version: string | null;
		changed: boolean;
		error?: string;
	};
	page_coverage: {
		available: number;
		visited: number;
		ratio: number;
		unvisited: string[];
		menu_available: number;
		menu_visited: number;
		menu_ratio: number;
		menu_unvisited: string[];
		off_manifest: string[];
	} | null;
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
}
