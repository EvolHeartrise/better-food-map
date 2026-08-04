<script lang="ts">
	/**
	 * Individual runs — the drill-down list, and where an A/B comparison starts.
	 *
	 * Failed runs stay in the list with their reason visible. They carry no report,
	 * so every metric column shows an em dash rather than a zero: a run that timed
	 * out at zero tool calls did not score 0% recall, it did not score at all.
	 */
	import { fetchRuns } from '../lib/api';
	import { duration, pct, timestamp, usd } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import type { RunRow } from '../lib/types';
	import Badge from '../components/Badge.svelte';

	let search = $state('');
	let compareA = $state<string | null>(null);

	let runs = $derived(await fetchRuns(filters.query));

	let visible = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return runs;
		return runs.filter((run) =>
			`${run.run_id} ${run.model} ${run.effort ?? ''} ${run.task} ${run.provenance}`
				.toLowerCase()
				.includes(needle)
		);
	});

	function pick(run: RunRow): void {
		if (compareA === null) {
			compareA = run.run_id;
			return;
		}
		if (compareA === run.run_id) {
			compareA = null;
			return;
		}
		router.go('compare', { a: compareA, b: run.run_id });
		compareA = null;
	}
</script>

<div class="stack">
	<div class="card">
		<div class="spread">
			<div>
				<h2>Runs</h2>
				<p class="muted small">
					{visible.length} of {runs.length} run{runs.length === 1 ? '' : 's'}.
					{#if compareA}
						Comparing from <strong>{compareA}</strong> — pick a second run.
					{:else}
						Use ⇄ on two runs of the same task to diff them item by item.
					{/if}
				</p>
			</div>
			<input type="search" placeholder="filter runs…" bind:value={search} />
		</div>

		<div class="scroll-x table-wrap">
			<table>
				<thead>
					<tr>
						<th class="left">Started</th>
						<th class="left">Task</th>
						<th class="left">Model</th>
						<th class="left">Effort</th>
						<th>Item R</th>
						<th>Item P</th>
						<th>Tag P</th>
						<th>Price</th>
						<th>Desc</th>
						<th>Unsafe</th>
						<th>Cost</th>
						<th>Time</th>
						<th class="left">State</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each visible as run (run.run_id)}
						<tr
							class="clickable"
							onclick={() => router.go('run', { id: run.run_id })}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									router.go('run', { id: run.run_id });
								}
							}}
							tabindex="0"
							role="button"
							aria-label="Open run {run.run_id}"
						>
							<td class="left mono">{timestamp(run.started_at)}</td>
							<td class="left">{run.task}</td>
							<td class="left">{run.model}</td>
							<td class="left">{run.effort ?? `default`}</td>
							<td>{pct(run.item_recall, 0)}</td>
							<td>{pct(run.item_precision, 0)}</td>
							<td>{pct(run.tag_precision, 0)}</td>
							<td>{pct(run.price_accuracy, 0)}</td>
							<td>{pct(run.description_accuracy, 0)}</td>
							<td class:danger={(run.unsafe_tag_claims ?? 0) > 0}>
								{run.unsafe_tag_claims ?? '—'}
							</td>
							<td>{usd(run.cost_usd)}</td>
							<td>{duration(run.duration_ms)}</td>
							<td class="left">
								{#if run.status === 'failed'}
									<Badge tone="bad" label="failed" title={run.failure_reason ?? undefined} />
								{:else if run.rerouted === 1}
									<Badge tone="warn" label="re-routed" />
								{:else}
									<span class="muted small">scored</span>
								{/if}
							</td>
							<td>
								<button
									class="chip"
									aria-pressed={compareA === run.run_id}
									title="Compare this run against another"
									onclick={(event) => {
										event.stopPropagation();
										pick(run);
									}}>⇄</button
								>
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

	.table-wrap {
		margin-top: 12px;
		max-height: 74vh;
		overflow-y: auto;
	}

	.clickable {
		cursor: pointer;
	}

	.danger {
		color: var(--critical);
		font-weight: 600;
	}

	input[type='search'] {
		min-width: 220px;
	}
</style>
