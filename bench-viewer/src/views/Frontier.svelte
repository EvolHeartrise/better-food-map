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
	import { fetchCells } from '../lib/api';
	import { duration, metricLabel, pct, usd } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import { frontierKeys as computeFrontier, plottableCells } from '../lib/analysis';
	import type { CellRow, ScatterPoint } from '../lib/types';
	import BlacklistBadge from '../components/BlacklistBadge.svelte';
	import ScatterChart from '../components/ScatterChart.svelte';

	type XAxis = 'cost' | 'cost_cached' | 'duration';

	const X_AXES: Record<XAxis, { label: string; format: (value: number) => string }> = {
		cost: { label: 'Cost per run (USD, real)', format: usd },
		cost_cached: { label: 'Cost per run (USD, perfect prefix cache)', format: usd },
		duration: { label: 'Agent wall-clock', format: duration }
	};

	let xAxis = $state<XAxis>('cost');

	let response = $derived(await fetchCells(filters.query, filters.mode, filters.dimensions));
	let cells = $derived(response.cells);

	function xValue(cell: CellRow): number | null {
		if (xAxis === 'cost') return cell.stats.cost_usd.mean;
		if (xAxis === 'cost_cached') return cell.stats.price_cached.mean;
		return cell.stats.duration_ms.mean;
	}

	let plotted = $derived(plottableCells(cells, xValue, filters.metric));

	// Cells missing an axis are excluded and counted, never plotted at zero.
	// Broken out by CAUSE: the note used to blame a missing cost for every
	// exclusion, including cells dropped because no run in them scored at all.
	let excludedNoScore = $derived(
		cells.filter((cell) => cell.metrics[filters.metric].mean === null).length
	);
	let excluded = $derived(cells.length - plotted.length);
	let excludedNoAxis = $derived(excluded - excludedNoScore);

	let frontier = $derived(computeFrontier(plotted));

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
			label: `${entry.cell.blacklist.state === 'none' ? '' : '⊘ '}${entry.cell.model.split('/').pop()} · ${entry.cell.effort}`,
			x: entry.x,
			y: entry.y,
			n: entry.cell.n_runs,
			frontier: frontier.has(entry.cell.key),
			detail: [
				`${entry.cell.n_tasks} task(s)`,
				entry.cell.quantization && entry.cell.quantization !== 'unpinned'
					? entry.cell.quantization
					: null,
				entry.cell.blacklist.state === 'none' ? null : 'blacklisted — verdict on record'
			]
				.filter(Boolean)
				.join(' · ')
		}))
	);

	let tableRows = $derived(plotted.toSorted((a, b) => b.y - a.y || a.x - b.x));

	function openFirstRun(cellKey: string): void {
		const cell = cells.find((entry) => entry.key === cellKey);
		if (cell?.run_ids.length) router.go('run', { id: cell.run_ids[0] });
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
			</div>
			<div class="row">
				{#each Object.keys(X_AXES) as key (key)}
					<button class="chip" aria-pressed={xAxis === key} onclick={() => (xAxis = key as XAxis)}>
						{key === 'cost' ? 'Real cost' : key === 'cost_cached' ? 'Cached cost' : 'Latency'}
					</button>
				{/each}
			</div>
		</div>

		<ScatterChart
			{points}
			xLabel={X_AXES[xAxis].label}
			yLabel={metricLabel(filters.metric)}
			formatX={X_AXES[xAxis].format}
			formatY={(value) => pct(value, 0)}
			logX={xAxis !== 'duration'}
			onselect={openFirstRun}
		/>

		{#if excluded > 0}
			<p class="muted small note">
				{excluded} cell{excluded === 1 ? '' : 's'} omitted{#if excludedNoAxis > 0}: {excludedNoAxis}
					with no {xAxis === 'duration' ? 'duration' : 'cost'} reported{/if}{#if excludedNoScore > 0}{excludedNoAxis >
					0
						? ','
						: ':'}
					{excludedNoScore} with no {metricLabel(filters.metric).toLowerCase()} to plot{/if}.
				Omitted, never plotted at zero — unreported is unknown, not free and not worst.
			</p>
		{/if}
	</div>

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
						<tr>
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
