<script lang="ts">
	/**
	 * The single filter row. Every view renders against this one slice — per-view
	 * filters are how two cards quietly end up describing different data.
	 *
	 * There is no averaging-mode control: every number is the task-equal (macro)
	 * average, which is exact for every metric. The item-pooled (micro) mode was
	 * removed from the UI deliberately — see `filters.mode`.
	 */
	import { fetchOverview } from '../lib/api';
	import { filters } from '../lib/state.svelte';
	import { metricLabel } from '../lib/format';
	import type { MetricKey } from '../lib/types';
	import Chip from './Chip.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Separator } from '$lib/components/ui/separator';

	let overview = $derived(await fetchOverview());
	let facets = $derived(overview.facets);
	let open = $state(false);
</script>

<Card.Root size="sm" class="gap-0 px-3 py-2.5">
	<div class="flex flex-wrap items-center gap-2">
		<Chip pressed={open} onPressedChange={(next) => (open = next)}>
			Filters{filters.active > 0 ? ` · ${filters.active}` : ''}
		</Chip>

		<label class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
			Metric
			<Select.Root
				type="single"
				value={filters.metric}
				onValueChange={(value) => (filters.metric = value as MetricKey)}
			>
				<Select.Trigger size="sm" class="h-7 text-xs">
					{metricLabel(filters.metric)}
				</Select.Trigger>
				<Select.Content>
					{#each facets.metrics as metric (metric)}
						<Select.Item value={metric} label={metricLabel(metric)} />
					{/each}
				</Select.Content>
			</Select.Root>
		</label>

		{#if filters.active > 0}
			<Button variant="ghost" size="xs" onclick={() => filters.reset()}>Clear</Button>
		{/if}
	</div>

	{#if open}
		<Separator class="mt-2.5 mb-2.5" />
		<div class="flex flex-col gap-2">
			<div class="flex flex-wrap items-baseline gap-2">
				<span class="min-w-[70px] text-xs text-muted-foreground">Task</span>
				<div class="flex flex-wrap items-center gap-1.5">
					{#each facets.tasks as task (task)}
						<Chip
							pressed={filters.tasks.includes(task)}
							onPressedChange={() => filters.toggle('tasks', task)}>{task}</Chip
						>
					{/each}
				</div>
			</div>

			<div class="flex flex-wrap items-baseline gap-2">
				<span class="min-w-[70px] text-xs text-muted-foreground">Model</span>
				<div class="flex flex-wrap items-center gap-1.5">
					{#each facets.models as model (model)}
						<Chip
							pressed={filters.models.includes(model)}
							onPressedChange={() => filters.toggle('models', model)}>{model}</Chip
						>
					{/each}
				</div>
			</div>

			<div class="flex flex-wrap items-baseline gap-2">
				<span class="min-w-[70px] text-xs text-muted-foreground">Effort</span>
				<div class="flex flex-wrap items-center gap-1.5">
					{#each facets.efforts as effort (effort)}
						<Chip
							pressed={filters.efforts.includes(effort)}
							onPressedChange={() => filters.toggle('efforts', effort)}>{effort}</Chip
						>
					{/each}
				</div>
			</div>

			<div class="flex flex-wrap items-baseline gap-2">
				<span class="min-w-[70px] text-xs text-muted-foreground">Failed runs</span>
				<Chip
					pressed={filters.includeFailed}
					onPressedChange={(next) => (filters.includeFailed = next)}
				>
					{filters.includeFailed ? 'included' : 'excluded'}
				</Chip>
				<span class="text-[11px] text-muted-foreground">
					A failure rate you can't see is a lie — keep them in.
				</span>
			</div>
		</div>
	{/if}
</Card.Root>
