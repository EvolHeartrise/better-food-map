<script lang="ts">
	/**
	 * The single filter row. Every view renders against this one slice — per-view
	 * filters are how two cards quietly end up describing different data.
	 *
	 * The averaging mode sits here rather than inside a chart for the same reason:
	 * macro (task-equal-weight) and micro (item-pooled) give different numbers, and
	 * which one is in force has to be visible while reading any of them.
	 */
	import { fetchOverview } from '../lib/api';
	import { filters, router } from '../lib/state.svelte';
	import { metricLabel } from '../lib/format';

	let overview = $derived(await fetchOverview(filters.revision));
	let facets = $derived(overview.facets);
	let blacklist = $derived(overview.blacklist);
	let open = $state(false);

	/**
	 * How many runs the corpus holds for retired configurations.
	 *
	 * Shown on the toggle whether or not they are hidden, because the number IS
	 * the disclosure: a leaderboard quietly missing 56 of 156 runs, with nothing
	 * on screen to say so, is the failure mode this control creates.
	 */
	let hiddenRuns = $derived(blacklist.n_blocked_runs);
</script>

<div class="bar">
	<div class="row wrap">
		<button class="chip" aria-pressed={open} onclick={() => (open = !open)}>
			Filters{filters.active > 0 ? ` · ${filters.active}` : ''}
		</button>

		{#if hiddenRuns > 0 || filters.includeBlacklisted}
			<button
				class="chip"
				aria-pressed={filters.includeBlacklisted}
				title="Configurations with a recorded verdict against them are hidden by default. Their runs are still in the corpus and keep their scores."
				onclick={() => (filters.includeBlacklisted = !filters.includeBlacklisted)}
			>
				{filters.includeBlacklisted
					? `⊘ showing blacklisted (${hiddenRuns} run${hiddenRuns === 1 ? '' : 's'})`
					: `⊘ ${hiddenRuns} blacklisted run${hiddenRuns === 1 ? '' : 's'} hidden`}
			</button>
		{/if}

		<label class="control">
			Average
			<select bind:value={filters.mode}>
				<option value="macro">macro (task-equal)</option>
				<option value="micro">micro (item-pooled)</option>
			</select>
		</label>

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
						{@const state = blacklist.model_states[model]}
						<button
							class="chip"
							class:retired={state === 'all'}
							aria-pressed={filters.models.includes(model)}
							title={state === 'all'
								? 'Every configuration of this model is blacklisted.'
								: state === 'partial'
									? 'Some configurations of this model are blacklisted.'
									: undefined}
							onclick={() => filters.toggle('models', model)}
						>
							<!-- The glyph, not the styling, is what carries the meaning: a chip
							     that only DIMMED would read as disabled under CVD or in print. -->
							{state === undefined ? '' : state === 'all' ? '⊘ ' : '⊘~ '}{model}
						</button>
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

			<div class="group">
				<span class="key">Blacklisted</span>
				<button
					class="chip"
					aria-pressed={filters.includeBlacklisted}
					onclick={() => (filters.includeBlacklisted = !filters.includeBlacklisted)}
				>
					{filters.includeBlacklisted ? 'shown' : 'hidden'}
				</button>
				<span class="hint">
					{blacklist.entries.length} verdict{blacklist.entries.length === 1 ? '' : 's'} on record, covering
					{hiddenRuns} run{hiddenRuns === 1 ? '' : 's'}.
					<button class="linky" onclick={() => router.go('blacklist')}>Review them</button>
				</span>
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

	.retired {
		color: var(--text-muted);
		border-style: dashed;
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
