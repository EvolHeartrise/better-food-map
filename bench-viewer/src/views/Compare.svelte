<script lang="ts">
	/**
	 * A/B two runs on the same task, item by item.
	 *
	 * Aggregate metrics say one run is better; this says WHERE. Items are keyed the
	 * way the scorer keys them (paren-insensitive normalized name), so what shows
	 * as "only in A" here is exactly what the scorer counted as a difference.
	 *
	 * Comparing runs of DIFFERENT tasks is refused rather than rendered: the gold
	 * differs, so an item-level diff would be noise dressed as a finding.
	 */
	import { fetchRunPair } from '../lib/api';
	import { metricLabel, pct, timestamp, usd } from '../lib/format';
	import { router } from '../lib/state.svelte';
	import { diffRuns, itemKey } from '../lib/analysis';
	import type { MenuItem, MetricKey } from '../lib/types';

	const METRICS: MetricKey[] = [
		'item_recall',
		'item_precision',
		'tag_precision',
		'tag_recall',
		'price_accuracy',
		'description_accuracy',
		'source_recall'
	];

	let pair = $derived(await fetchRunPair(router.param('a'), router.param('b')));
	let a = $derived(pair?.[0] ?? null);
	let b = $derived(pair?.[1] ?? null);

	let sameTask = $derived(a !== null && b !== null && a.run.task === b.run.task);

	/**
	 * Two runs of the same task scored against different gold versions are not
	 * comparable — their frozen reports answer different questions. The aggregated
	 * views badge this; the one view that IS an explicit head-to-head must too.
	 */
	let goldConflict = $derived(
		sameTask && a !== null && b !== null && a.run.policy_version !== b.run.policy_version
	);

	let diff = $derived(
		a && b && sameTask ? diffRuns(a.candidate_items, b.candidate_items, a.gold_items) : null
	);

	/** Marks an item the gold actually lists, so a diff row reads as signal or noise. */
	function inGold(item: MenuItem): boolean {
		return diff?.goldKeys.has(itemKey(item.name)) ?? false;
	}
</script>

{#if !a || !b}
	<div class="card"><p class="muted">Pick two runs from the Runs view to compare.</p></div>
{:else}
	<div class="stack">
		<div class="card">
			<div class="spread">
				<h2>Run comparison</h2>
				<button class="chip" onclick={() => router.go('runs')}>← All runs</button>
			</div>

			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="left"></th>
							<th class="left">A</th>
							<th class="left">B</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="left muted">Run</td>
							<td class="left">{a.run.model} · {a.run.effort ?? 'default'}</td>
							<td class="left">{b.run.model} · {b.run.effort ?? 'default'}</td>
						</tr>
						<tr>
							<td class="left muted">Task</td>
							<td class="left">{a.run.task}</td>
							<td class="left">{b.run.task}</td>
						</tr>
						<tr>
							<td class="left muted">Started</td>
							<td class="left mono">{timestamp(a.run.started_at)}</td>
							<td class="left mono">{timestamp(b.run.started_at)}</td>
						</tr>
						<tr>
							<td class="left muted">Gold</td>
							<td class="left" class:conflict={goldConflict}>
								{a.run.policy_version ?? 'unknown'}
							</td>
							<td class="left" class:conflict={goldConflict}>
								{b.run.policy_version ?? 'unknown'}
							</td>
						</tr>
						<tr>
							<td class="left muted">Provenance</td>
							<td class="left">{a.derived.provenance}</td>
							<td class="left">{b.derived.provenance}</td>
						</tr>
						{#if a.blacklist || b.blacklist}
							<!-- Only when one side is retired. A head-to-head that quietly pits a
							     live configuration against a decommissioned one reads as an open
							     question when it is not one. -->
							<tr>
								<td class="left muted">Blacklisted</td>
								<td class="left">
									{#if a.blacklist}
										<span title={a.blacklist.reason}>⊘ {a.blacklist.label}</span>
									{:else}
										<span class="muted">no</span>
									{/if}
								</td>
								<td class="left">
									{#if b.blacklist}
										<span title={b.blacklist.reason}>⊘ {b.blacklist.label}</span>
									{:else}
										<span class="muted">no</span>
									{/if}
								</td>
							</tr>
						{/if}
						<tr>
							<td class="left muted">Cost</td>
							<td class="left">{usd(a.derived.cost_usd)}</td>
							<td class="left">{usd(b.derived.cost_usd)}</td>
						</tr>
						{#each METRICS as metric (metric)}
							{@const left = a.run.report?.[metric] ?? null}
							{@const right = b.run.report?.[metric] ?? null}
							<tr>
								<td class="left muted">{metricLabel(metric)}</td>
								<td class="left" class:better={left !== null && right !== null && left > right}>
									{pct(left)}
								</td>
								<td class="left" class:better={left !== null && right !== null && right > left}>
									{pct(right)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		{#if goldConflict}
			<div class="card">
				<p class="danger">
					These runs were scored against DIFFERENT versions of {a.run.task}'s gold ({a.run
						.policy_version ?? 'unknown'} vs {b.run.policy_version ?? 'unknown'}). Their frozen
					reports answer different questions, so the metric table above is not a like-for-like
					comparison — open each run and use "Score against current gold" to compare them on equal
					terms.
				</p>
			</div>
		{/if}

		{#if !sameTask}
			<div class="card">
				<p class="danger">
					These runs are on different tasks ({a.run.task} vs {b.run.task}). Their golds differ, so
					an item-level diff would compare two different menus — the metric table above is the only
					honest comparison here, and even that only holds if you read it as two separate
					measurements.
				</p>
			</div>
		{:else if diff}
			<div class="card">
				<div class="spread">
					<h2>Item differences</h2>
					<p class="muted small">
						Keyed the way the scorer keys items, so a difference here is a difference it counted. ★
						marks an item present in gold.
					</p>
				</div>

				<div class="split">
					<div>
						<h3>Only in A ({diff.onlyA.length})</h3>
						<ul class="list">
							{#each diff.onlyA as item (item.name)}
								<li>{inGold(item) ? '★ ' : ''}{item.name}</li>
							{:else}
								<li class="muted">None</li>
							{/each}
						</ul>
					</div>
					<div>
						<h3>Only in B ({diff.onlyB.length})</h3>
						<ul class="list">
							{#each diff.onlyB as item (item.name)}
								<li>{inGold(item) ? '★ ' : ''}{item.name}</li>
							{:else}
								<li class="muted">None</li>
							{/each}
						</ul>
					</div>
				</div>

				{#if diff.differing.length > 0}
					<h3>Same item, different value ({diff.differing.length})</h3>
					<div class="scroll-x">
						<table>
							<thead>
								<tr>
									<th class="left">Item</th>
									<th class="left">Field</th>
									<th class="left">A</th>
									<th class="left">B</th>
								</tr>
							</thead>
							<tbody>
								{#each diff.differing as row, index (row.name + row.field + index)}
									<tr>
										<td class="left">{row.name}</td>
										<td class="left muted">{row.field}</td>
										<td class="left">{row.a}</td>
										<td class="left">{row.b}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.small {
		font-size: 11px;
	}

	.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 24px;
		margin-top: 10px;
	}

	@media (max-width: 800px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.list {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12px;
		max-height: 340px;
		overflow-y: auto;
	}

	h3 {
		margin: 14px 0 4px;
		color: var(--text-secondary);
	}

	.conflict {
		color: var(--critical);
		font-weight: 600;
	}

	.better {
		color: var(--good);
		font-weight: 600;
	}

	.danger {
		color: var(--critical);
	}
</style>
