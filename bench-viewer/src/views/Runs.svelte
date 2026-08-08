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
	import Chip from '../components/Chip.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';

	let search = $state('');
	let compareA = $state<string | null>(null);

	let response = $derived(await fetchRuns(filters.query));
	let runs = $derived(response.runs);

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

<Card.Root size="sm">
	<Card.Header class="gap-0">
		<Card.Title>Runs</Card.Title>
		<Card.Description class="text-xs">
			{visible.length} of {runs.length} run{runs.length === 1 ? '' : 's'}.
			{#if compareA}
				Comparing from <strong>{compareA}</strong> — pick a second run.
			{:else}
				Use ⇄ on two runs of the same task to diff them item by item.
			{/if}
		</Card.Description>
		<Card.Action class="self-center">
			<Input
				type="search"
				placeholder="filter runs…"
				bind:value={search}
				class="h-8 min-w-[220px] text-xs"
			/>
		</Card.Action>
	</Card.Header>

	<Card.Content>
		<div
			class="max-h-[74vh] overflow-auto rounded-md border [&_[data-slot=table-container]]:static [&_[data-slot=table-container]]:overflow-visible"
		>
			<Table.Root class="num-table text-[13px] tabular-nums">
				<Table.Header class="sticky top-0 z-10 bg-card">
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="text-left text-xs">Started</Table.Head>
						<Table.Head class="text-left text-xs">Task</Table.Head>
						<Table.Head class="text-left text-xs">Model</Table.Head>
						<Table.Head class="text-left text-xs">Effort</Table.Head>
						<Table.Head class="text-xs">Item R</Table.Head>
						<Table.Head class="text-xs">Item P</Table.Head>
						<Table.Head class="text-xs">Tag P</Table.Head>
						<Table.Head class="text-xs">Price</Table.Head>
						<Table.Head class="text-xs">Desc</Table.Head>
						<Table.Head class="text-xs">Unsafe</Table.Head>
						<Table.Head class="text-xs">Cost</Table.Head>
						<Table.Head class="text-xs">Time</Table.Head>
						<Table.Head class="text-left text-xs">State</Table.Head>
						<Table.Head></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each visible as run (run.run_id)}
						<Table.Row
							class="cursor-pointer hover:bg-primary/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
							onclick={() => router.go('run', { id: run.run_id })}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									router.go('run', { id: run.run_id });
								}
							}}
							tabindex={0}
							role="button"
							aria-label="Open run {run.run_id}"
						>
							<Table.Cell class="text-left font-mono text-xs"
								>{timestamp(run.started_at)}</Table.Cell
							>
							<Table.Cell class="text-left">{run.task}</Table.Cell>
							<Table.Cell class="text-left">{run.model}</Table.Cell>
							<Table.Cell class="text-left">{run.effort ?? `default`}</Table.Cell>
							<Table.Cell>{pct(run.item_recall, 0)}</Table.Cell>
							<Table.Cell>{pct(run.item_precision, 0)}</Table.Cell>
							<Table.Cell>{pct(run.tag_precision, 0)}</Table.Cell>
							<Table.Cell>{pct(run.price_accuracy, 0)}</Table.Cell>
							<Table.Cell>{pct(run.description_accuracy, 0)}</Table.Cell>
							<Table.Cell
								class={(run.unsafe_tag_claims ?? 0) > 0 ? 'font-semibold text-critical' : ''}
							>
								{run.unsafe_tag_claims ?? '—'}
							</Table.Cell>
							<Table.Cell>{usd(run.cost_usd)}</Table.Cell>
							<Table.Cell>{duration(run.duration_ms)}</Table.Cell>
							<Table.Cell class="text-left">
								{#if run.status === 'failed'}
									<Badge tone="bad" label="failed" title={run.failure_reason ?? undefined} />
								{:else if run.rerouted === 1}
									<Badge tone="warn" label="re-routed" />
								{:else}
									<span class="text-[11px] text-muted-foreground">scored</span>
								{/if}
							</Table.Cell>
							<Table.Cell onclick={(event: MouseEvent) => event.stopPropagation()}>
								<Chip
									pressed={compareA === run.run_id}
									title="Compare this run against another"
									onPressedChange={() => pick(run)}>⇄</Chip
								>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		{#if visible.length === 0}
			<p class="pt-4 pb-1 text-muted-foreground">
				{runs.length === 0 ? 'No runs match this filter.' : `No runs match “${search}”.`}
			</p>
		{/if}
	</Card.Content>
</Card.Root>
