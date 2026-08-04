/**
 * Bench index export — the headless half of the analytics tooling.
 *
 * Dumps the run index (or its aggregated config cells) as JSON or CSV so the
 * corpus can be queried without the viewer: pipe it into jq, open it in a
 * spreadsheet, or diff two sweeps. The viewer and this command read through the
 * SAME aggregation code, so a number here always matches the number on screen.
 *
 * Usage:
 *   bun run bench:export [--rows runs|cells] [--format json|csv]
 *                        [--mode macro|micro] [--runs-dir <dir>] [--out <file>]
 *
 * Data goes to stdout (or `--out`); human notes go to stderr. Exit 0 even when
 * there is no bench data — `bench/` is gitignored, so "absent" is a normal
 * state, reported as an empty result rather than an error.
 */
import { writeFileSync } from 'node:fs';
import { buildCells, METRIC_KEYS, type AverageMode, type Cell } from './aggregate';
import { deriveRun } from './derive';
import { DEFAULT_RUNS_DIR, loadRunIndex, type RunRecord } from './record';

type RowKind = 'runs' | 'cells';
type Format = 'json' | 'csv';

export interface ExportArgs {
	rows: RowKind;
	format: Format;
	mode: AverageMode;
	runsDir: string;
	out?: string;
}

export type ArgsResult = { ok: true; args: ExportArgs } | { ok: false; error: string };

const USAGE =
	'usage: bun run bench:export [--rows runs|cells] [--format json|csv] ' +
	'[--mode macro|micro] [--runs-dir <dir>] [--out <file>]';

export function parseArgs(argv: readonly string[]): ArgsResult {
	const args: ExportArgs = {
		rows: 'runs',
		format: 'json',
		mode: 'macro',
		runsDir: DEFAULT_RUNS_DIR
	};

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		// A value that is itself a flag means the user forgot one. Without this,
		// `--out --format` writes a 200 KB file literally named "--format".
		const raw = argv[i + 1];
		const value = raw !== undefined && raw.startsWith('--') ? undefined : raw;
		switch (flag) {
			case '--rows':
				if (value !== 'runs' && value !== 'cells')
					return { ok: false, error: `--rows must be runs|cells` };
				args.rows = value;
				i++;
				break;
			case '--format':
				if (value !== 'json' && value !== 'csv')
					return { ok: false, error: `--format must be json|csv` };
				args.format = value;
				i++;
				break;
			case '--mode':
				if (value !== 'macro' && value !== 'micro')
					return { ok: false, error: `--mode must be macro|micro` };
				args.mode = value;
				i++;
				break;
			case '--runs-dir':
				if (!value) return { ok: false, error: '--runs-dir needs a path' };
				args.runsDir = value;
				i++;
				break;
			case '--out':
				if (!value) return { ok: false, error: '--out needs a path' };
				args.out = value;
				i++;
				break;
			default:
				return { ok: false, error: `unknown argument: ${flag}` };
		}
	}
	return { ok: true, args };
}

/** Flatten a run to a single CSV/JSON row: scalars only, no nested lists. */
export function runRow(run: RunRecord): Record<string, string | number | null> {
	const derived = deriveRun(run);
	return {
		run_id: run.run_id,
		task: run.task,
		model: run.model,
		backend: run.backend,
		effort: run.effort,
		effort_default: run.effort_default,
		temperature: run.temperature,
		quantization_requested: run.quantization_requested?.join('+') ?? null,
		provenance: derived.provenance,
		rerouted: derived.rerouted ? 1 : 0,
		policy_version: run.policy_version,
		status: run.status,
		failure_reason: run.failure_reason,
		started_at: run.started_at,
		duration_ms: run.duration_ms,
		wall_clock_ms: run.wall_clock_ms,
		bench_overhead_ms: derived.bench_overhead_ms,
		tool_calls: run.tool_calls,
		submit_attempts: run.submit_attempts,
		prompt_tokens: run.prompt_tokens,
		completion_tokens: run.completion_tokens,
		total_tokens: run.total_tokens,
		cached_prompt_tokens: run.cached_prompt_tokens,
		cache_hit_rate: derived.cache_hit_rate,
		output_tok_per_s: derived.output_tok_per_s,
		cost_usd: derived.cost_usd,
		cost_source: derived.cost_source,
		price_cached: run.price_cached,
		unsafe_tag_claims: derived.unsafe_tag_claims,
		gold_items: run.report?.gold_items ?? null,
		candidate_items: run.report?.candidate_items ?? null,
		matched: run.report?.matched ?? null,
		...Object.fromEntries(METRIC_KEYS.map((key) => [key, run.report?.[key] ?? null]))
	};
}

/** Flatten a cell, carrying `n` beside every mean so no rank is read without it. */
export function cellRow(cell: Cell): Record<string, string | number | null> {
	const row: Record<string, string | number | null> = {
		key: cell.key,
		...cell.dims,
		n_runs: cell.n_runs,
		n_scored: cell.n_scored,
		n_failed: cell.n_failed,
		failure_rate: cell.failure_rate,
		tasks: cell.tasks.join('+'),
		n_tasks: cell.tasks.length,
		scored_tasks: cell.scored_tasks.join('+'),
		n_scored_tasks: cell.scored_tasks.length,
		unattributed_runs: cell.unattributed_runs,
		policy_versions: cell.policy_versions.join('+'),
		policy_conflict_tasks: cell.policy_conflicts.map((conflict) => conflict.task).join('+'),
		mixed_provenance: cell.provenances.length > 1 ? 1 : 0,
		rerouted: cell.rerouted ? 1 : 0,
		unsafe_tag_claims_total: cell.unsafe_tag_claims_total,
		cost_usd_mean: cell.cost_usd.mean,
		cost_usd_n: cell.cost_usd.n,
		price_cached_mean: cell.price_cached.mean,
		duration_ms_mean: cell.duration_ms.mean,
		duration_ms_sd: cell.duration_ms.sd,
		total_tokens_mean: cell.total_tokens.mean,
		cache_hit_rate_mean: cell.cache_hit_rate.mean,
		output_tok_per_s_mean: cell.output_tok_per_s.mean
	};
	for (const metric of METRIC_KEYS) {
		const stat = cell.metrics[metric];
		row[`${metric}_mean`] = stat.mean;
		row[`${metric}_sd`] = stat.sd;
		row[`${metric}_n`] = stat.n;
		if (stat.approx) row[`${metric}_approx`] = 1;
	}
	return row;
}

/** RFC4180-ish: quote when needed, double inner quotes, empty cell for null. */
export function toCsv(rows: readonly Record<string, string | number | null>[]): string {
	if (rows.length === 0) return '';
	// Union of keys, first-seen order — an optional column (a metric's `approx`
	// flag) must not vanish just because row 1 lacked it.
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				columns.push(key);
			}
		}
	}
	const escape = (value: string | number | null | undefined): string => {
		if (value === null || value === undefined) return '';
		const text = String(value);
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	return [
		columns.join(','),
		...rows.map((row) => columns.map((column) => escape(row[column])).join(','))
	].join('\n');
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		console.error(parsed.error);
		console.error(USAGE);
		return 2;
	}
	const { args } = parsed;

	const index = loadRunIndex(args.runsDir);
	if (index.runs.length === 0) {
		console.error(`no bench runs under ${args.runsDir} — nothing to export`);
	}
	for (const problem of index.problems) {
		console.error(`skipped ${problem.dir}: ${problem.error}`);
	}

	const rows =
		args.rows === 'runs'
			? index.runs.map((run) => runRow(run))
			: buildCells(index.runs, { mode: args.mode }).map((cell) => cellRow(cell));

	const output = args.format === 'csv' ? toCsv(rows) : JSON.stringify(rows, null, '\t');

	if (args.out) {
		try {
			writeFileSync(args.out, output.endsWith('\n') ? output : `${output}\n`);
		} catch (error) {
			console.error(
				`could not write ${args.out}: ${error instanceof Error ? error.message : String(error)}`
			);
			return 2;
		}
		console.error(`wrote ${rows.length} ${args.rows} row(s) to ${args.out}`);
	} else {
		// stdout is DATA here (matching bench:score), so it must not go through
		// console.log — human notes all go to stderr.
		process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
	}
	if (args.rows === 'cells') {
		console.error(
			`${rows.length} config cell(s), ${args.mode}-averaged, from ${index.runs.length} run(s)`
		);
	}
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
