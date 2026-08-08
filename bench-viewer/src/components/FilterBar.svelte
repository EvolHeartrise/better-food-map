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

	let overview = $derived(await fetchOverview());
	let facets = $derived(overview.facets);
	let open = $state(false);
</script>

<div class="bar">
	<div class="row wrap">
		<button class="chip" aria-pressed={open} onclick={() => (open = !open)}>
			Filters{filters.active > 0 ? ` · ${filters.active}` : ''}
		</button>

		<label class="control">
			Metric
			<select bind:value={filters.metric}>
				{#each facets.metrics as metric (metric)}
					<option value={metric}>{metricLabel(metric)}</option>
				{/each}
			</select>
		</label>

		{#if filters.active > 0}
			<button class="chip" onclick={() => filters.reset()}>Clear</button>
		{/if}
	</div>

	{#if open}
		<div class="panel">
			<div class="group">
				<span class="key">Task</span>
				<div class="row wrap">
					{#each facets.tasks as task (task)}
						<button
							class="chip"
							aria-pressed={filters.tasks.includes(task)}
							onclick={() => filters.toggle('tasks', task)}>{task}</button
						>
					{/each}
				</div>
			</div>

			<div class="group">
				<span class="key">Model</span>
				<div class="row wrap">
					{#each facets.models as model (model)}
						<button
							class="chip"
							aria-pressed={filters.models.includes(model)}
							onclick={() => filters.toggle('models', model)}>{model}</button
						>
					{/each}
				</div>
			</div>

			<div class="group">
				<span class="key">Effort</span>
				<div class="row wrap">
					{#each facets.efforts as effort (effort)}
						<button
							class="chip"
							aria-pressed={filters.efforts.includes(effort)}
							onclick={() => filters.toggle('efforts', effort)}>{effort}</button
						>
					{/each}
				</div>
			</div>

			<div class="group">
				<span class="key">Failed runs</span>
				<button
					class="chip"
					aria-pressed={filters.includeFailed}
					onclick={() => (filters.includeFailed = !filters.includeFailed)}
				>
					{filters.includeFailed ? 'included' : 'excluded'}
				</button>
				<span class="hint">A failure rate you can't see is a lie — keep them in.</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.bar {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 10px 12px;
	}

	.control {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-secondary);
		font-size: 12px;
	}

	.panel {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--gridline);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.group {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.key {
		color: var(--text-secondary);
		font-size: 12px;
		min-width: 70px;
	}

	.hint {
		color: var(--text-muted);
		font-size: 11px;
	}
</style>
