<script lang="ts">
	/**
	 * The leaderboard: one row per configuration cell, the scorer's metric vector
	 * as columns.
	 *
	 * There is deliberately NO composite index. The scorer keeps recall and
	 * precision apart because they fail differently — a hallucinated free-of tag
	 * is a safety problem, a missed tag is a completeness problem — and averaging
	 * them into a single "intelligence score" would erase exactly that. Ranking is
	 * whichever column you sort by, and `n` sits beside every rank because most
	 * cells here are one or two runs deep.
	 */
	import { fetchCells, fetchOverview } from '../lib/api';
	import { count, duration, metricLabel, pct, usd } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import type { CellRow, MetricKey } from '../lib/types';
	import Badge from '../components/Badge.svelte';
	import SortButton from '../components/SortButton.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';

	const COLUMNS: MetricKey[] = [
		'item_recall',
		'item_precision',
		'tag_precision',
		'tag_recall',
		'price_accuracy',
		'description_accuracy',
		'source_recall'
	];

	let sortKey = $state<string>('item_recall');
	let sortDesc = $state(true);
	let expanded = $state<string | null>(null);

	// Data lives in a derived await, not an effect that assigns state. Svelte holds
	// the current table on screen until the new slice resolves, so refiltering
	// never flashes a skeleton.
	let response = $derived(await fetchCells(filters.query, filters.mode, filters.dimensions));
	let cells = $derived(response.cells);

	let overview = $derived(await fetchOverview());
	let totalTasks = $derived(
		filters.tasks.length > 0 ? filters.tasks.length : overview.counts.tasks
	);

	/** Null means UNKNOWN — never a value, so it never participates in the order. */
	function sortValue(cell: CellRow, key: string): number | string | null {
		switch (key) {
			case 'config':
				return cell.key;
			case 'n':
				return cell.n_runs;
			case 'failures':
				return cell.failure_rate;
			case 'unsafe':
				return cell.stats.unsafe_tag_claims.n === 0 ? null : cell.unsafe_tag_claims_total;
			case 'cost':
				return cell.stats.cost_usd.mean;
			case 'duration':
				return cell.stats.duration_ms.mean;
			default:
				return cell.metrics[key as MetricKey]?.mean ?? null;
		}
	}

	let sorted = $derived.by(() => {
		const rows = [...cells];
		rows.sort((a, b) => {
			const left = sortValue(a, sortKey);
			const right = sortValue(b, sortKey);
			// Unknowns sink in BOTH directions. Sorting them as -Infinity put a cell
			// whose cost was never reported at the top of a cheapest-first list,
			// where its position asserted it was the cheapest thing on the board.
			if (left === null && right === null) return a.key.localeCompare(b.key);
			if (left === null) return 1;
			if (right === null) return -1;
			const comparison =
				typeof left === 'string' || typeof right === 'string'
					? String(left).localeCompare(String(right))
					: left - right;
			return sortDesc ? -comparison : comparison;
		});
		return rows;
	});

	function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
		if (sortKey !== key) return 'none';
		return sortDesc ? 'descending' : 'ascending';
	}

	function toggleSort(key: string): void {
		if (sortKey === key) sortDesc = !sortDesc;
		else {
			sortKey = key;
			sortDesc = true;
		}
	}

	/** `± sd` only once there are enough runs for a spread to mean anything. */
	function spread(stat: { sd: number | null; n: number }): string {
		if (stat.n < 3 || stat.sd === null) return '';
		return ` ±${(stat.sd * 100).toFixed(1)}`;
	}
</script>

<Card.Root size="sm">
	<Card.Header class="gap-0">
		<Card.Title>Configurations</Card.Title>
		<Card.Description class="text-xs">
			{cells.length} cell{cells.length === 1 ? '' : 's'} · task-equal average (every task weighs the same)
			· sorted by
			{sortKey === 'config' ? 'configuration' : metricLabel(sortKey)}
		</Card.Description>
		<Card.Action class="self-center text-xs text-muted-foreground">
			No composite score by design — recall and precision fail differently.
		</Card.Action>
	</Card.Header>

	<Card.Content>
		<div
			class="max-h-[70vh] overflow-auto rounded-md border [&_[data-slot=table-container]]:static [&_[data-slot=table-container]]:overflow-visible"
		>
			<Table.Root class="num-table text-[13px] tabular-nums">
				<Table.Header class="sticky top-0 z-10 bg-card">
					<Table.Row class="hover:bg-transparent">
						<Table.Head aria-sort={ariaSort('config')}>
							<SortButton
								active={sortKey === 'config'}
								desc={sortDesc}
								onclick={() => toggleSort('config')}>Configuration</SortButton
							>
						</Table.Head>
						<Table.Head aria-sort={ariaSort('n')}>
							<SortButton
								active={sortKey === 'n'}
								desc={sortDesc}
								onclick={() => toggleSort('n')}
								title="scored runs (of all runs) · tasks scored">n</SortButton
							>
						</Table.Head>
						{#each COLUMNS as column (column)}
							<Table.Head aria-sort={ariaSort(column)}>
								<SortButton
									active={sortKey === column}
									desc={sortDesc}
									onclick={() => toggleSort(column)}>{metricLabel(column)}</SortButton
								>
							</Table.Head>
						{/each}
						<Table.Head aria-sort={ariaSort('unsafe')}>
							<SortButton
								active={sortKey === 'unsafe'}
								desc={sortDesc}
								onclick={() => toggleSort('unsafe')}
								title="Dietary tags the candidate asserted that gold does not support"
								>Unsafe tags</SortButton
							>
						</Table.Head>
						<Table.Head aria-sort={ariaSort('cost')}>
							<SortButton
								active={sortKey === 'cost'}
								desc={sortDesc}
								onclick={() => toggleSort('cost')}>Cost</SortButton
							>
						</Table.Head>
						<Table.Head aria-sort={ariaSort('duration')}>
							<SortButton
								active={sortKey === 'duration'}
								desc={sortDesc}
								onclick={() => toggleSort('duration')}>Time</SortButton
							>
						</Table.Head>
						<Table.Head aria-sort={ariaSort('failures')}>
							<SortButton
								active={sortKey === 'failures'}
								desc={sortDesc}
								onclick={() => toggleSort('failures')}>Fail</SortButton
							>
						</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each sorted as cell (cell.key)}
						<Table.Row
							class="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring {expanded ===
							cell.key
								? 'bg-primary/8 hover:bg-primary/10'
								: 'hover:bg-primary/5'}"
							onclick={() => (expanded = expanded === cell.key ? null : cell.key)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									expanded = expanded === cell.key ? null : cell.key;
								}
							}}
							tabindex={0}
							role="button"
							aria-expanded={expanded === cell.key}
							aria-label="{cell.model} {cell.effort}: show details"
						>
							<Table.Cell>
								<div class="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
									{cell.model}
								</div>
								<div class="text-[11px] text-muted-foreground">
									effort {cell.effort}{cell.quantization ? ` · ${cell.quantization}` : ''} ·
									{cell.backend}
								</div>
								<!-- The agent setup sits with the model because it IS part of what was
								     measured: a two-pass row and a single-pass row of the same model are
								     two systems, not two samples. `single-pass` is left implicit to keep
								     the default row quiet; anything else is called out. -->
								{#if cell.harness && cell.harness !== 'single-pass'}
									<!-- A non-default agent setup is configuration, not decoration — it
									     reads at the same weight as the model line rather than fading
									     into the muted metadata. -->
									<div class="text-[11px] font-semibold text-primary">
										{cell.harness}{cell.review && cell.review !== 'none' && cell.review !== 'same'
											? ` · review: ${cell.review}`
											: ''}
									</div>
								{/if}
							</Table.Cell>
							<Table.Cell
								title="{cell.n_scored} scored of {cell.n_runs} run(s), across {cell.n_scored_tasks} task(s)"
							>
								<span>{cell.n_scored}</span>
								{#if cell.n_failed > 0}<span class="text-[11px] text-muted-foreground"
										>/{cell.n_runs}</span
									>{/if}
								<span class="text-[11px] text-muted-foreground">·{cell.n_scored_tasks}t</span>
							</Table.Cell>
							{#each COLUMNS as column (column)}
								{@const stat = cell.metrics[column]}
								<!-- stat.unpoolable can no longer occur here: it is a micro-mode
								     state, and the viewer is pinned to macro, which is exact for
								     every metric. -->
								<Table.Cell>
									{pct(stat.mean, 1)}<span class="text-[11px] text-muted-foreground"
										>{spread(stat)}</span
									>
								</Table.Cell>
							{/each}
							<Table.Cell
								class={cell.unsafe_tag_claims_total > 0 ? 'font-semibold text-critical' : ''}
							>
								{#if cell.stats.unsafe_tag_claims.n === 0}
									<span
										class="text-muted-foreground"
										title="No run in this cell produced a report, so nothing is known about its dietary claims."
										>—</span
									>
								{:else}
									{cell.unsafe_tag_claims_total}
								{/if}
							</Table.Cell>
							<Table.Cell>{usd(cell.stats.cost_usd.mean)}</Table.Cell>
							<Table.Cell>{duration(cell.stats.duration_ms.mean)}</Table.Cell>
							<Table.Cell class={cell.n_failed > 0 ? 'font-semibold text-critical' : ''}>
								{cell.n_failed > 0 ? pct(cell.failure_rate, 0) : '0'}
							</Table.Cell>
						</Table.Row>

						{#if expanded === cell.key}
							<Table.Row class="bg-primary/4 hover:bg-primary/4">
								<Table.Cell colspan={COLUMNS.length + 5} class="p-3 pb-3.5 whitespace-normal">
									<div class="mb-2 flex flex-wrap items-center gap-2">
										{#if cell.n_runs === 1}
											<Badge
												tone="warn"
												label="n=1"
												title="One run. Nothing here separates skill from sampling noise."
											/>
										{/if}
										{#if totalTasks > 0 && cell.n_scored_tasks < totalTasks}
											<Badge
												tone="warn"
												label="{cell.n_scored_tasks}/{totalTasks} tasks scored"
												title="This cell did not produce a score on every task in the current slice, so its average is not comparable to a full-coverage cell."
											/>
										{/if}
										{#if cell.unattributed_runs > 0}
											<Badge
												tone="warn"
												label="provenance not recorded"
												title="No provider or quantization tier was recorded, so this score cannot be attributed to a specific endpoint."
											/>
										{/if}
										{#if cell.rerouted === 1}
											<Badge
												tone="bad"
												label="re-routed mid-run"
												title="More than one upstream provider served a single run."
											/>
										{/if}
										{#if cell.policy_conflict_tasks}
											<Badge
												tone="bad"
												label="gold changed: {cell.policy_conflict_tasks}"
												title="Runs of the same task were scored against different gold versions. Their frozen reports are not comparable — open a run and use Rescore."
											/>
										{/if}
										{#if cell.n_failed > 0}
											<Badge tone="bad" label="{cell.n_failed} failed" />
										{/if}
									</div>

									<div
										class="mb-2 flex flex-wrap gap-x-4.5 gap-y-1 text-[11px] text-muted-foreground"
									>
										<span>Provenance: {cell.provenances.join(' / ')}</span>
										<span>Tasks: {cell.tasks}</span>
										<span>Gold: {cell.policy_versions}</span>
										{#if cell.harness}<span>Harness: {cell.harness}</span>{/if}
										{#if cell.review && cell.review !== 'none'}
											<span>Review pass: {cell.review}</span>
										{/if}
										<!-- `unknown` means the run predates prompt hashing, NOT that it used
										     today's prompt. Those runs are kept in their own cell for exactly
										     that reason, so the label has to say which it is. -->
										{#if cell.prompt_sha}
											<span
												title={cell.prompt_sha === 'unknown'
													? 'This run predates prompt hashing, so which prompt produced it is unrecorded — it is NOT known to match the current prompt.'
													: 'Content hash of each pass prompt. Runs under different prompts never share a cell.'}
												>Prompt: {cell.prompt_sha}</span
											>
										{/if}
										<span>Tokens: {count(cell.stats.total_tokens.mean)} avg</span>
										<span>Cache read: {pct(cell.stats.cache_hit_rate.mean, 0)}</span>
										<span
											>Perfect-cache cost: {usd(cell.stats.price_cached.mean)}
											<span class="text-muted-foreground/70">(counterfactual)</span></span
										>
									</div>

									<div class="flex flex-wrap items-center gap-1.5">
										{#each cell.run_ids as runId (runId)}
											<Button
												variant="outline"
												size="xs"
												class="h-6 rounded-full font-normal"
												onclick={(event) => {
													event.stopPropagation();
													router.go('run', { id: runId });
												}}>{runId.split('/')[0]} · {runId.split('/')[1].slice(0, 20)}</Button
											>
										{/each}
									</div>
								</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		{#if cells.length === 0}
			<p class="pt-4 pb-1 text-muted-foreground">No runs match this filter.</p>
		{/if}
	</Card.Content>
</Card.Root>
