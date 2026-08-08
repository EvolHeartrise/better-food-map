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
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';

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

<div class="flex flex-col gap-4">
	<Card.Root size="sm">
		<Card.Header class="gap-0">
			<Card.Title>Discriminating power</Card.Title>
			<Card.Description class="text-xs">
				Spread of configuration means on {metricLabel(filters.metric).toLowerCase()}. A task where
				every configuration lands in the same place has stopped telling you anything — that is the
				cue to record a harder venue, not to celebrate the scores.
			</Card.Description>
		</Card.Header>

		<Card.Content class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
			<div>
				<h3 class="mb-2.5 text-[11px] text-muted-foreground">
					Spread across configurations (sd, percentage points)
				</h3>
				<BarChart bars={spreadBars} format={(value) => `${(value * 100).toFixed(1)} pp`} />
			</div>

			<div class="min-w-0">
				<Table.Root class="num-table text-[13px] tabular-nums">
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="text-xs">Task</Table.Head>
							<Table.Head
								class="text-xs"
								title="configuration cells that produced a score, of all that ran this task"
								>Scored cells</Table.Head
							>
							<Table.Head class="text-xs">Best</Table.Head>
							<Table.Head class="text-xs">Worst</Table.Head>
							<Table.Head class="text-xs">Range</Table.Head>
							<Table.Head class="text-xs">At ceiling</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each discrimination as task (task.task)}
							<Table.Row class="hover:bg-primary/5">
								<Table.Cell>{task.task}</Table.Cell>
								<Table.Cell>
									{task.n_scored_cells}{#if task.n_scored_cells !== task.n_cells}<span
											class="text-[11px] text-muted-foreground">/{task.n_cells}</span
										>{/if}
								</Table.Cell>
								<Table.Cell>{pct(task.best, 0)}</Table.Cell>
								<Table.Cell>{pct(task.worst, 0)}</Table.Cell>
								<Table.Cell>{pct(task.range, 1)}</Table.Cell>
								<Table.Cell
									class={(task.ceiling_share ?? 0) >= 0.8 ? 'font-semibold text-serious' : ''}
								>
									{pct(task.ceiling_share, 0)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				<p class="mt-2 text-[11px] text-muted-foreground">
					"At ceiling" is the share of configurations scoring ≥ 99.9%. Approaching 100% means the
					task is exhausted for the models in this slice.
				</p>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header class="gap-0">
			<Card.Title>Configuration × task</Card.Title>
			<Card.Description class="text-xs">
				{metricLabel(filters.metric)} per intersection. A plain dash means that configuration never ran
				that task; a dash with <strong>!</strong> means it ran and produced no score. Neither is a zero.
				Click a cell to filter the leaderboard to its task.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<Heatmap
				{rows}
				{columns}
				value={cellValue}
				format={(value) => pct(value, 0)}
				onselect={openTask}
			/>
		</Card.Content>
	</Card.Root>
</div>
