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
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';

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
	<Card.Root size="sm">
		<Card.Content class="text-muted-foreground">
			Pick two runs from the Runs view to compare.
		</Card.Content>
	</Card.Root>
{:else}
	<div class="flex flex-col gap-4">
		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>Run comparison</Card.Title>
				<Card.Action class="self-center">
					<Button variant="outline" size="xs" onclick={() => router.go('runs')}>← All runs</Button>
				</Card.Action>
			</Card.Header>

			<Card.Content>
				<Table.Root class="text-[13px] tabular-nums">
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="text-xs"></Table.Head>
							<Table.Head class="text-xs">A</Table.Head>
							<Table.Head class="text-xs">B</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Run</Table.Cell>
							<Table.Cell>{a.run.model} · {a.run.effort ?? 'default'}</Table.Cell>
							<Table.Cell>{b.run.model} · {b.run.effort ?? 'default'}</Table.Cell>
						</Table.Row>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Task</Table.Cell>
							<Table.Cell>{a.run.task}</Table.Cell>
							<Table.Cell>{b.run.task}</Table.Cell>
						</Table.Row>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Started</Table.Cell>
							<Table.Cell class="font-mono text-xs">{timestamp(a.run.started_at)}</Table.Cell>
							<Table.Cell class="font-mono text-xs">{timestamp(b.run.started_at)}</Table.Cell>
						</Table.Row>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Gold</Table.Cell>
							<Table.Cell class={goldConflict ? 'font-semibold text-critical' : ''}>
								{a.run.policy_version ?? 'unknown'}
							</Table.Cell>
							<Table.Cell class={goldConflict ? 'font-semibold text-critical' : ''}>
								{b.run.policy_version ?? 'unknown'}
							</Table.Cell>
						</Table.Row>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Provenance</Table.Cell>
							<Table.Cell>{a.derived.provenance}</Table.Cell>
							<Table.Cell>{b.derived.provenance}</Table.Cell>
						</Table.Row>
						<Table.Row>
							<Table.Cell class="text-muted-foreground">Cost</Table.Cell>
							<Table.Cell>{usd(a.derived.cost_usd)}</Table.Cell>
							<Table.Cell>{usd(b.derived.cost_usd)}</Table.Cell>
						</Table.Row>
						{#each METRICS as metric (metric)}
							{@const left = a.run.report?.[metric] ?? null}
							{@const right = b.run.report?.[metric] ?? null}
							<Table.Row>
								<Table.Cell class="text-muted-foreground">{metricLabel(metric)}</Table.Cell>
								<Table.Cell
									class={left !== null && right !== null && left > right
										? 'font-semibold text-good'
										: ''}
								>
									{pct(left)}
								</Table.Cell>
								<Table.Cell
									class={left !== null && right !== null && right > left
										? 'font-semibold text-good'
										: ''}
								>
									{pct(right)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		{#if goldConflict}
			<Card.Root size="sm" class="border-critical/45">
				<Card.Content class="text-critical">
					These runs were scored against DIFFERENT versions of {a.run.task}'s gold ({a.run
						.policy_version ?? 'unknown'} vs {b.run.policy_version ?? 'unknown'}). Their frozen
					reports answer different questions, so the metric table above is not a like-for-like
					comparison — open each run and use "Score against current gold" to compare them on equal
					terms.
				</Card.Content>
			</Card.Root>
		{/if}

		{#if !sameTask}
			<Card.Root size="sm" class="border-critical/45">
				<Card.Content class="text-critical">
					These runs are on different tasks ({a.run.task} vs {b.run.task}). Their golds differ, so
					an item-level diff would compare two different menus — the metric table above is the only
					honest comparison here, and even that only holds if you read it as two separate
					measurements.
				</Card.Content>
			</Card.Root>
		{:else if diff}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>Item differences</Card.Title>
					<Card.Description class="text-xs">
						Keyed the way the scorer keys items, so a difference here is a difference it counted. ★
						marks an item present in gold.
					</Card.Description>
				</Card.Header>

				<Card.Content>
					<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
						<div>
							<h3 class="text-[13px] text-muted-foreground">Only in A ({diff.onlyA.length})</h3>
							<ul class="mt-1.5 max-h-[340px] list-disc overflow-y-auto pl-4.5 text-xs">
								{#each diff.onlyA as item (item.name)}
									<li>{inGold(item) ? '★ ' : ''}{item.name}</li>
								{:else}
									<li class="text-muted-foreground">None</li>
								{/each}
							</ul>
						</div>
						<div>
							<h3 class="text-[13px] text-muted-foreground">Only in B ({diff.onlyB.length})</h3>
							<ul class="mt-1.5 max-h-[340px] list-disc overflow-y-auto pl-4.5 text-xs">
								{#each diff.onlyB as item (item.name)}
									<li>{inGold(item) ? '★ ' : ''}{item.name}</li>
								{:else}
									<li class="text-muted-foreground">None</li>
								{/each}
							</ul>
						</div>
					</div>

					{#if diff.differing.length > 0}
						<h3 class="mt-4 mb-1 text-[13px] text-muted-foreground">
							Same item, different value ({diff.differing.length})
						</h3>
						<Table.Root class="text-[13px]">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Item</Table.Head>
									<Table.Head class="text-xs">Field</Table.Head>
									<Table.Head class="text-xs">A</Table.Head>
									<Table.Head class="text-xs">B</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each diff.differing as row, index (row.name + row.field + index)}
									<Table.Row>
										<Table.Cell>{row.name}</Table.Cell>
										<Table.Cell class="text-muted-foreground">{row.field}</Table.Cell>
										<Table.Cell>{row.a}</Table.Cell>
										<Table.Cell>{row.b}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
{/if}
