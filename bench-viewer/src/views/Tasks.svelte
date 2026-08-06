<script lang="ts">
	/**
	 * Task view: which venues still separate configurations, and which have gone
	 * to ceiling.
	 *
	 * This is the bench-authoring signal. A task every model aces has stopped
	 * paying for its place in the sweep — the corpus already has one (namdhari
	 * went to ceiling for frontier models within a day of being authored) — and
	 * the spread of cell means is what says so.
	 */
	import { fetchCells, fetchDiscrimination } from '../lib/api';
	import { metricLabel, pct } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import { heatLookup, heatRows } from '../lib/analysis';
	import BarChart from '../components/BarChart.svelte';
	import Heatmap from '../components/Heatmap.svelte';

	let discrimination = $derived(
		await fetchDiscrimination(filters.query, filters.mode, filters.metric)
	);

	// Grouped by config AND task, so the heatmap has a value per intersection.
	let heat = $derived(
		await fetchCells(filters.query, filters.mode, [
			'model',
			'backend',
			'effort',
			'quantization',
			// Provenance splits cells on the leaderboard, so it must split rows
			// here too — otherwise this grid silently merges two endpoints the
			// leaderboard keeps apart.
			'provenance',
			'task'
		])
	);
	let cells = $derived(heat.cells);

	let columns = $derived(
		[...new Set(cells.map((cell) => cell.task ?? ''))].filter(Boolean).toSorted()
	);

	let rows = $derived(heatRows(cells));
	let lookup = $derived(heatLookup(cells, filters.metric));

	function cellValue(rowKey: string, column: string) {
		return lookup.get(`${rowKey}::${column}`) ?? null;
	}

	function openTask(_rowKey: string, task: string): void {
		filters.tasks = [task];
		router.go('leaderboard');
	}

	let spreadBars = $derived(
		discrimination
			.toSorted((a, b) => (b.sd ?? 0) - (a.sd ?? 0))
			.map((task) => ({
				label: task.task,
				value: task.sd,
				note: `${task.n_scored_cells} scored cells`
			}))
	);
</script>

<div class="stack">
	<div class="card">
		<div class="spread">
			<div>
				<h2>Discriminating power</h2>
				<p class="muted small">
					Spread of configuration means on {metricLabel(filters.metric).toLowerCase()}. A task where
					every configuration lands in the same place has stopped telling you anything — that is the
					cue to record a harder venue, not to celebrate the scores.
				</p>
			</div>
		</div>

		<div class="grid">
			<div>
				<h3 class="muted small">Spread across configurations (sd, percentage points)</h3>
				<BarChart bars={spreadBars} format={(value) => `${(value * 100).toFixed(1)} pp`} />
			</div>

			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="left">Task</th>
							<th title="configuration cells that produced a score, of all that ran this task"
								>Scored cells</th
							>
							<th>Best</th>
							<th>Worst</th>
							<th>Range</th>
							<th>At ceiling</th>
						</tr>
					</thead>
					<tbody>
						{#each discrimination as task (task.task)}
							<tr>
								<td class="left">{task.task}</td>
								<td>
									{task.n_scored_cells}{#if task.n_scored_cells !== task.n_cells}<span
											class="muted small">/{task.n_cells}</span
										>{/if}
								</td>
								<td>{pct(task.best, 0)}</td>
								<td>{pct(task.worst, 0)}</td>
								<td>{pct(task.range, 1)}</td>
								<td class:spent={(task.ceiling_share ?? 0) >= 0.8}>
									{pct(task.ceiling_share, 0)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="muted small note">
					"At ceiling" is the share of configurations scoring ≥ 99.9%. Approaching 100% means the
					task is exhausted for the models in this slice.
				</p>
			</div>
		</div>
	</div>

	<div class="card">
		<h2>Configuration × task</h2>
		<p class="muted small">
			{metricLabel(filters.metric)} per intersection. A plain dash means that configuration never ran
			that task; a dash with <strong>!</strong> means it ran and produced no score. Neither is a
			zero. Click a cell to filter the leaderboard to its task.
			{#if heat.hidden_blacklisted > 0}
				<!-- Named here because this view is the bench-AUTHORING signal: judging a
				     task "exhausted" from a grid that quietly dropped a third of its
				     configurations is how a still-useful venue gets retired. -->
				{heat.hidden_blacklisted} run{heat.hidden_blacklisted === 1 ? '' : 's'} on blacklisted configurations
				are excluded from this grid and from the spread above.
				<button class="linky" onclick={() => (filters.includeBlacklisted = true)}>
					Include them
				</button>
			{:else if filters.includeBlacklisted}
				Rows marked <strong>⊘</strong> are blacklisted configurations.
			{/if}
		</p>
		<div class="heat">
			<Heatmap
				{rows}
				{columns}
				value={cellValue}
				format={(value) => pct(value, 0)}
				onselect={openTask}
			/>
		</div>
	</div>
</div>

<style>
	.small {
		font-size: 11px;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 24px;
		margin-top: 14px;
		align-items: start;
	}

	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.heat {
		margin-top: 12px;
	}

	.note {
		margin: 8px 0 0;
	}

	.spent {
		color: var(--serious);
		font-weight: 600;
	}

	h3 {
		margin-bottom: 10px;
		font-weight: 600;
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
