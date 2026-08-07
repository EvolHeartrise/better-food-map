<script lang="ts">
	/**
	 * Quality against cost (or latency), with the Pareto frontier called out —
	 * the "what should we actually run" view.
	 *
	 * The cost axis can be flipped between REAL billed cost and the perfect-prefix-
	 * caching counterfactual the harness records alongside it. That second number
	 * is the interesting one for a menu-refresh workload: the bench loop is
	 * append-only, so a production caller that keeps its prefix warm pays closer to
	 * `price_cached` than to `price`.
	 */
	import { fetchCells, fetchRuns } from '../lib/api';
	import { count, duration, metricLabel, pct, usd } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import { frontierKeys as computeFrontier, plottableCells } from '../lib/analysis';
	import type { CellRow, ScatterPoint } from '../lib/types';
	import BlacklistBadge from '../components/BlacklistBadge.svelte';
	import ScatterChart from '../components/ScatterChart.svelte';

	type XAxis = 'cost' | 'cost_cached' | 'duration';

	/**
	 * Grouping with and without the attribution axes.
	 *
	 * SPLIT is the server default and the honest one: a score measures model x
	 * provider x quantization x prompt, so runs served by different endpoints are
	 * not repeats of one measurement. POOLED drops `provenance` and `prompt_sha`
	 * only — `harness` stays split either way, because a two-pass run and a
	 * single-pass run are different SYSTEMS, not two samples of one, and pooling
	 * them would put a number on the chart describing neither.
	 */
	const SPLIT_DIMS = [
		'model',
		'backend',
		'effort',
		'temperature',
		'quantization',
		'provenance',
		'harness',
		'review',
		'prompt_sha'
	];
	const POOLED_DIMS = [
		'model',
		'backend',
		'effort',
		'temperature',
		'quantization',
		'harness',
		'review'
	];

	const X_AXES: Record<XAxis, { label: string; format: (value: number) => string }> = {
		cost: { label: 'Cost per run (USD, real)', format: usd },
		cost_cached: { label: 'Cost per run (USD, perfect prefix cache)', format: usd },
		duration: { label: 'Agent wall-clock', format: duration }
	};

	let xAxis = $state<XAxis>('cost');
	let splitProvenance = $state(true);
	/** The cell whose runs are expanded below the chart, or null. */
	let selectedKey = $state<string | null>(null);

	let dims = $derived(
		filters.dimensions.length > 0 ? filters.dimensions : splitProvenance ? SPLIT_DIMS : POOLED_DIMS
	);

	let response = $derived(await fetchCells(filters.query, filters.mode, dims));
	let cells = $derived(response.cells);
	// The same slice the chart is built from, so an expanded point can show its
	// runs without a second round of filtering logic that could drift from it.
	let runsResponse = $derived(await fetchRuns(filters.query));

	function xValue(cell: CellRow): number | null {
		if (xAxis === 'cost') return cell.stats.cost_usd.mean;
		if (xAxis === 'cost_cached') return cell.stats.price_cached.mean;
		return cell.stats.duration_ms.mean;
	}

	const taskList = (value: string): string[] => (value ? value.split('+') : []);

	/**
	 * How many distinct tasks any cell in this slice actually produced a score on.
	 * This is the coverage bar a cell has to clear to be comparable.
	 */
	let sliceTaskCount = $derived(new Set(cells.flatMap((cell) => taskList(cell.scored_tasks))).size);

	let plottedAll = $derived(plottableCells(cells, xValue, filters.metric));

	/**
	 * Only cells scored on EVERY task in the slice are plotted.
	 *
	 * A frontier is a claim that nothing beats these points on both axes, and that
	 * claim is meaningless across configurations measured on different venues: a
	 * cell that only ran the easiest task scores near the ceiling for a fraction of
	 * the cost and lands on the frontier looking like the thing to run. That is not
	 * a cheaper configuration, it is a smaller sample of an easier question.
	 */
	let plotted = $derived(
		plottedAll.filter((entry) => taskList(entry.cell.scored_tasks).length >= sliceTaskCount)
	);

	// Exclusions are counted BY CAUSE and always surfaced. Silently dropping a
	// third of the corpus is how a chart says "we compared everything" about a
	// slice.
	let excludedNoScore = $derived(
		cells.filter((cell) => cell.metrics[filters.metric].mean === null).length
	);
	let excludedNoAxis = $derived(cells.length - plottedAll.length - excludedNoScore);
	let excludedPartial = $derived(plottedAll.length - plotted.length);
	let excluded = $derived(cells.length - plotted.length);

	let frontier = $derived(computeFrontier(plotted));

	/**
	 * Point labels only carry the axes that actually distinguish them.
	 *
	 * `model · effort` alone rendered three different `deepseek-v4-flash · low`
	 * points identically — one of them a single run on one task. A label that
	 * cannot tell two points apart is worse than a long one, so the disambiguators
	 * are appended only where a base label collides.
	 */
	let baseLabelCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const entry of plotted) {
			const base = `${entry.cell.model.split('/').pop()} · ${entry.cell.effort}`;
			counts[base] = (counts[base] ?? 0) + 1;
		}
		return counts;
	});

	function labelFor(cell: CellRow): string {
		const base = `${cell.model.split('/').pop()} · ${cell.effort}`;
		const retired = cell.blacklist.state === 'none' ? '' : '⊘ ';
		if ((baseLabelCounts[base] ?? 0) <= 1) return `${retired}${base}`;
		const extra = [
			cell.harness && cell.harness !== 'single-pass' ? cell.harness : null,
			cell.quantization && cell.quantization !== 'unpinned' ? cell.quantization : null,
			// The provider, not the whole provenance string, which is too long here.
			cell.provenance ? cell.provenance.split(' ')[0].split('@')[0] : null
		].filter(Boolean);
		return `${retired}${base}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
	}

	/** Runs belonging to the expanded cell, richest-context first. */
	let selectedCell = $derived(
		selectedKey === null ? null : (cells.find((cell) => cell.key === selectedKey) ?? null)
	);

	let selectedRuns = $derived.by(() => {
		if (!selectedCell) return [];
		const ids = new Set(selectedCell.run_ids);
		return runsResponse.runs
			.filter((run) => ids.has(run.run_id))
			.toSorted((a, b) => a.task.localeCompare(b.task) || a.started_at.localeCompare(b.started_at));
	});

	/**
	 * The blacklist marker is folded into the point LABEL, not just the tooltip.
	 *
	 * This is the view where the omission would do real damage: a retired
	 * configuration can sit on the Pareto frontier and get direct-labelled as the
	 * thing to run — several verdicts in the corpus were written about configs
	 * that scored well and lost on cost, which is exactly what puts them there.
	 */
	let points = $derived.by<ScatterPoint[]>(() =>
		plotted.map((entry) => ({
			id: entry.cell.key,
			label: labelFor(entry.cell),
			x: entry.x,
			y: entry.y,
			n: entry.cell.n_runs,
			frontier: frontier.has(entry.cell.key),
			detail: [
				`${entry.cell.n_runs} run(s) over ${entry.cell.n_tasks} task(s)`,
				entry.cell.harness && entry.cell.harness !== 'single-pass' ? entry.cell.harness : null,
				entry.cell.quantization && entry.cell.quantization !== 'unpinned'
					? entry.cell.quantization
					: null,
				splitProvenance && entry.cell.provenance ? entry.cell.provenance : null,
				entry.cell.blacklist.state === 'none' ? null : 'blacklisted — verdict on record'
			]
				.filter(Boolean)
				.join(' · ')
		}))
	);

	let tableRows = $derived(plotted.toSorted((a, b) => b.y - a.y || a.x - b.x));

	/**
	 * Selecting a point EXPANDS it rather than navigating.
	 *
	 * This used to jump straight to `run_ids[0]`, which showed one arbitrary run —
	 * in practice whichever task sorted first — and read as though the point WAS
	 * that run. A point is an average over a cell; the useful drill-down is the
	 * set it averages over.
	 */
	function selectCell(cellKey: string): void {
		selectedKey = selectedKey === cellKey ? null : cellKey;
	}
</script>

<div class="stack">
	<div class="card">
		<div class="spread">
			<div>
				<h2>{metricLabel(filters.metric)} against {X_AXES[xAxis].label.toLowerCase()}</h2>
				<p class="muted small">
					Labelled points are the Pareto frontier — nothing beats them on both axes. Point identity
					is in the tooltip and the table below, not in colour.
				</p>
				{#if response.hidden_blacklisted > 0}
					<p class="muted small">
						{response.hidden_blacklisted} run{response.hidden_blacklisted === 1 ? '' : 's'} on blacklisted
						configurations excluded — the frontier below is over live candidates only.
						<button class="linky" onclick={() => (filters.includeBlacklisted = true)}>
							Include them
						</button>
					</p>
				{:else if filters.includeBlacklisted}
					<p class="muted small">
						Blacklisted configurations are included and marked <strong>⊘</strong>. A retired config
						can still sit on the frontier — that is usually why it was retired.
					</p>
				{/if}
				{#if !splitProvenance}
					<p class="warn small">
						Pooled: runs served by different providers, quantizations and prompts share a point, so
						each one describes no single actual endpoint. Good for ranking models, not for
						attributing a score. (Harness stays split — a two-pass run is a different system, not
						another sample.)
					</p>
				{/if}
				{#if filters.dimensions.length > 0}
					<p class="muted small">
						Grouping is pinned by the filter panel, so the split toggle does not apply.
					</p>
				{/if}
			</div>
			<div class="row wrap controls">
				{#each Object.keys(X_AXES) as key (key)}
					<button class="chip" aria-pressed={xAxis === key} onclick={() => (xAxis = key as XAxis)}>
						{key === 'cost' ? 'Real cost' : key === 'cost_cached' ? 'Cached cost' : 'Latency'}
					</button>
				{/each}
				<label
					class="split"
					title="A score measures model x provider x quantization x prompt. Pooling those axes gives one number that describes no single endpoint — useful for comparing models, wrong for attributing a result."
				>
					<input type="checkbox" bind:checked={splitProvenance} />
					split by provenance &amp; prompt
				</label>
			</div>
		</div>

		<ScatterChart
			{points}
			xLabel={X_AXES[xAxis].label}
			yLabel={metricLabel(filters.metric)}
			formatX={X_AXES[xAxis].format}
			formatY={(value) => pct(value, 0)}
			logX={xAxis !== 'duration'}
			onselect={selectCell}
		/>

		{#if excluded > 0}
			{@const causes = [
				excludedNoAxis > 0
					? `${excludedNoAxis} with no ${xAxis === 'duration' ? 'duration' : 'cost'} reported`
					: null,
				excludedNoScore > 0
					? `${excludedNoScore} with no ${metricLabel(filters.metric).toLowerCase()} to plot`
					: null,
				excludedPartial > 0
					? `${excludedPartial} scored on only some of the ${sliceTaskCount} task(s) in this slice`
					: null
			].filter(Boolean)}
			<p class="muted small note">
				{excluded} cell{excluded === 1 ? '' : 's'} omitted{causes.length
					? `: ${causes.join(', ')}`
					: ''}. Omitted, never plotted at zero — unreported is unknown, not free and not worst.
				{#if excludedPartial > 0}
					A configuration measured on fewer venues is a smaller sample of an easier question, not a
					cheaper configuration; it cannot be compared on this chart.
				{/if}
			</p>
		{/if}
	</div>

	{#if selectedCell}
		<div class="card">
			<div class="spread">
				<div>
					<h3>
						{selectedCell.model}
						<span class="muted">· {selectedCell.effort}</span>
						<BlacklistBadge
							state={selectedCell.blacklist.state}
							entries={selectedCell.blacklist.entries}
							compact
						/>
					</h3>
					<p class="muted small">
						{selectedCell.n_runs} run{selectedCell.n_runs === 1 ? '' : 's'} over
						{selectedCell.n_tasks} task{selectedCell.n_tasks === 1 ? '' : 's'} ·
						{selectedCell.harness}{selectedCell.review && selectedCell.review !== 'none'
							? ` · review: ${selectedCell.review}`
							: ''}{selectedCell.quantization && selectedCell.quantization !== 'unpinned'
							? ` · ${selectedCell.quantization}`
							: ''}{splitProvenance && selectedCell.provenance
							? ` · ${selectedCell.provenance}`
							: ''}
					</p>
					<!-- The plotted point is a MEAN over these rows. Saying so beside them is
					     what stops a reader treating the point as a single result. -->
					<p class="muted small">
						The plotted point is the {filters.mode} average of these runs:
						<strong>{pct(selectedCell.metrics[filters.metric].mean)}</strong>
						{metricLabel(filters.metric).toLowerCase()} at
						<strong>{X_AXES[xAxis].format(xValue(selectedCell) ?? 0)}</strong>.
					</p>
				</div>
				<button class="chip" onclick={() => (selectedKey = null)}>Close</button>
			</div>

			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="left">Task</th>
							<th>Item R</th>
							<th>Item P</th>
							<th>Tag R</th>
							<th>Tag P</th>
							<th>Cost</th>
							<th>Time</th>
							<th>Tokens</th>
							<th class="left">Started</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each selectedRuns as run (run.run_id)}
							<tr class:failed={run.status === 'failed'}>
								<td class="left">{run.task}</td>
								{#if run.status === 'failed'}
									<!-- A failed run has no report and is never counted as 0% — it is not
									     in the mean above either. -->
									<td colspan="5" class="left muted">
										failed{run.failure_reason ? `: ${run.failure_reason.slice(0, 70)}` : ''}
									</td>
								{:else}
									<td>{pct(run.item_recall)}</td>
									<td>{pct(run.item_precision)}</td>
									<td>{pct(run.tag_recall)}</td>
									<td>{pct(run.tag_precision)}</td>
									<td>{usd(run.cost_usd)}</td>
								{/if}
								<td>{duration(run.duration_ms)}</td>
								<td>{count(run.total_tokens)}</td>
								<td class="left muted small">{run.started_at.slice(0, 16).replace('T', ' ')}</td>
								<td>
									<button class="linky" onclick={() => router.go('run', { id: run.run_id })}>
										open →
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if selectedRuns.length !== selectedCell.n_runs}
				<p class="muted small note">
					Showing {selectedRuns.length} of {selectedCell.n_runs} runs — the rest are outside the current
					filter slice.
				</p>
			{/if}
		</div>
	{/if}

	<div class="card">
		<h3>Table view</h3>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="left">Configuration</th>
						<th>{metricLabel(filters.metric)}</th>
						<th>{X_AXES[xAxis].label}</th>
						<th>n</th>
						<th>Tasks</th>
						<th class="left">Frontier</th>
					</tr>
				</thead>
				<tbody>
					{#each tableRows as entry (entry.cell.key)}
						<!-- Clickable so the table and the chart select the same way; keyboard
						     reachable because a row is the only handle on a point whose label
						     the chart may have had to abbreviate. -->
						<tr
							class:selected={entry.cell.key === selectedKey}
							onclick={() => selectCell(entry.cell.key)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									selectCell(entry.cell.key);
								}
							}}
							tabindex="0"
							role="button"
							aria-pressed={entry.cell.key === selectedKey}
							aria-label="{entry.cell.model} {entry.cell.effort}: show runs"
						>
							<td class="left">
								{entry.cell.model} <span class="muted">· {entry.cell.effort}</span>
								<BlacklistBadge
									state={entry.cell.blacklist.state}
									entries={entry.cell.blacklist.entries}
									compact
								/>
							</td>
							<td>{pct(entry.y)}</td>
							<td>{X_AXES[xAxis].format(entry.x)}</td>
							<td>{entry.cell.n_runs}</td>
							<td>{entry.cell.n_tasks}</td>
							<td class="left">
								{#if frontier.has(entry.cell.key)}<span class="on">on frontier</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>

<style>
	.small {
		font-size: 11px;
	}

	.note {
		margin: 8px 0 0;
	}

	.on {
		color: var(--good);
		font-weight: 600;
		font-size: 12px;
	}

	h3 {
		margin-bottom: 8px;
	}

	.controls {
		gap: 8px;
		align-items: center;
	}

	.split {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: pointer;
	}

	.warn {
		color: var(--warning);
		max-width: 80ch;
	}

	tbody tr.selected {
		background: color-mix(in srgb, var(--series-1) 12%, transparent);
	}

	tbody tr.failed td {
		opacity: 0.75;
	}

	.linky {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--series-1);
		cursor: pointer;
		text-decoration: underline;
	}
</style>
