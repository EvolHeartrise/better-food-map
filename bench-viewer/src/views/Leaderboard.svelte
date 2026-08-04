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
	let cells = $derived((await fetchCells(filters.query, filters.mode, filters.dimensions)).cells);

	let totalTasks = $derived(
		filters.tasks.length > 0 ? filters.tasks.length : (await fetchOverview()).counts.tasks
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

<div class="stack">
	<div class="card">
		<div class="spread">
			<div>
				<h2>Configurations</h2>
				<p class="muted small">
					{cells.length} cell{cells.length === 1 ? '' : 's'} · {filters.mode === 'macro'
						? 'macro-averaged (every task weighs the same)'
						: 'micro-averaged (pooled over items, so big menus dominate)'} · sorted by
					{sortKey === 'config' ? 'configuration' : metricLabel(sortKey)}
				</p>
			</div>
			<p class="muted small right">
				No composite score by design — recall and precision fail differently.
			</p>
		</div>

		<div class="scroll-x table-wrap">
			<table>
				<thead>
					<tr>
						<!-- Real <button>s inside the cells: a click handler on a <th> is
						     unreachable by keyboard and announces no sort state. -->
						<th class="left" aria-sort={ariaSort('config')}>
							<button class="sortable" onclick={() => toggleSort('config')}>Configuration</button>
						</th>
						<th aria-sort={ariaSort('n')}>
							<button
								class="sortable"
								onclick={() => toggleSort('n')}
								title="scored runs (of all runs) · tasks scored">n</button
							>
						</th>
						{#each COLUMNS as column (column)}
							<th aria-sort={ariaSort(column)}>
								<button class="sortable" onclick={() => toggleSort(column)}
									>{metricLabel(column)}</button
								>
							</th>
						{/each}
						<th aria-sort={ariaSort('unsafe')}>
							<button
								class="sortable"
								onclick={() => toggleSort('unsafe')}
								title="Dietary tags the candidate asserted that gold does not support"
								>Unsafe tags</button
							>
						</th>
						<th aria-sort={ariaSort('cost')}>
							<button class="sortable" onclick={() => toggleSort('cost')}>Cost</button>
						</th>
						<th aria-sort={ariaSort('duration')}>
							<button class="sortable" onclick={() => toggleSort('duration')}>Time</button>
						</th>
						<th aria-sort={ariaSort('failures')}>
							<button class="sortable" onclick={() => toggleSort('failures')}>Fail</button>
						</th>
					</tr>
				</thead>
				<tbody>
					{#each sorted as cell (cell.key)}
						<tr
							class="clickable"
							class:expanded={expanded === cell.key}
							onclick={() => (expanded = expanded === cell.key ? null : cell.key)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									expanded = expanded === cell.key ? null : cell.key;
								}
							}}
							tabindex="0"
							role="button"
							aria-expanded={expanded === cell.key}
							aria-label="{cell.model} {cell.effort}: show details"
						>
							<td class="left">
								<div class="config">{cell.model}</div>
								<div class="muted small">
									effort {cell.effort}{cell.quantization ? ` · ${cell.quantization}` : ''} ·
									{cell.backend}
								</div>
							</td>
							<td
								title="{cell.n_scored} scored of {cell.n_runs} run(s), across {cell.n_scored_tasks} task(s)"
							>
								<span class="num">{cell.n_scored}</span>
								{#if cell.n_failed > 0}<span class="muted small">/{cell.n_runs}</span>{/if}
								<span class="muted small">·{cell.n_scored_tasks}t</span>
							</td>
							{#each COLUMNS as column (column)}
								{@const stat = cell.metrics[column]}
								<td>
									{pct(stat.mean, 1)}<span class="muted small">{spread(stat)}</span>
									{#if stat.approx}<span
											class="muted small"
											title="pooled from ratios without their denominators">~</span
										>{/if}
								</td>
							{/each}
							<td class:danger={cell.unsafe_tag_claims_total > 0}>
								{#if cell.stats.unsafe_tag_claims.n === 0}
									<span
										class="muted"
										title="No run in this cell produced a report, so nothing is known about its dietary claims."
										>—</span
									>
								{:else}
									{cell.unsafe_tag_claims_total}
								{/if}
							</td>
							<td>{usd(cell.stats.cost_usd.mean)}</td>
							<td>{duration(cell.stats.duration_ms.mean)}</td>
							<td class:danger={cell.n_failed > 0}>
								{cell.n_failed > 0 ? pct(cell.failure_rate, 0) : '0'}
							</td>
						</tr>

						{#if expanded === cell.key}
							<tr class="detail">
								<td colspan={COLUMNS.length + 5}>
									<div class="row wrap badges">
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

									<div class="meta muted small">
										<span>Provenance: {cell.provenances.join(' / ')}</span>
										<span>Tasks: {cell.tasks}</span>
										<span>Gold: {cell.policy_versions}</span>
										<span>Tokens: {count(cell.stats.total_tokens.mean)} avg</span>
										<span>Cache read: {pct(cell.stats.cache_hit_rate.mean, 0)}</span>
										<span
											>Perfect-cache cost: {usd(cell.stats.price_cached.mean)}
											<span class="muted">(counterfactual)</span></span
										>
									</div>

									<div class="row wrap runs">
										{#each cell.run_ids as runId (runId)}
											<button
												class="chip"
												onclick={(event) => {
													event.stopPropagation();
													router.go('run', { id: runId });
												}}>{runId.split('/')[0]} · {runId.split('/')[1].slice(0, 20)}</button
											>
										{/each}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>

		{#if cells.length === 0}
			<p class="muted pad">No runs match this filter.</p>
		{/if}
	</div>
</div>

<style>
	.small {
		font-size: 11px;
	}

	.right {
		text-align: right;
	}

	.table-wrap {
		margin-top: 12px;
		max-height: 70vh;
		overflow-y: auto;
	}

	.config {
		font-weight: 600;
		font-size: 13px;
	}

	.clickable {
		cursor: pointer;
	}

	.expanded {
		background: color-mix(in srgb, var(--series-1) 8%, transparent);
	}

	.detail td {
		background: color-mix(in srgb, var(--series-1) 4%, transparent);
		white-space: normal;
		padding: 10px 12px 14px;
	}

	.badges {
		margin-bottom: 8px;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
		margin-bottom: 8px;
	}

	.runs {
		gap: 6px;
	}

	.danger {
		color: var(--critical);
		font-weight: 600;
	}

	.pad {
		padding: 16px 0 4px;
	}
</style>
