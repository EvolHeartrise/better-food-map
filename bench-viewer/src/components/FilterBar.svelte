<script lang="ts">
	/**
	 * The single filter row. Every view renders against this one slice — per-view
	 * filters are how two cards quietly end up describing different data.
	 *
	 * There is no averaging-mode control: every number is the task-equal (macro)
	 * average, which is exact for every metric. The item-pooled (micro) mode was
	 * removed from the UI deliberately — see `filters.mode`.
	 */
	import { fetchOverview, fetchSlice } from '../lib/api';
	import { filters, router } from '../lib/state.svelte';
	import { metricLabel } from '../lib/format';

	let overview = $derived(await fetchOverview(filters.revision));
	let facets = $derived(overview.facets);
	let blacklist = $derived(overview.blacklist);
	let open = $state(false);

	/**
	 * The number on the toggle IS the disclosure: a leaderboard quietly missing 62
	 * of 156 runs, with nothing on screen to say so, is the failure mode this
	 * control creates.
	 *
	 * It must therefore be scoped to the CURRENT SLICE, not to the corpus. Filter
	 * to a model with no verdict against it and the corpus number still claims 62
	 * runs are hidden while every view below shows none hidden — the control that
	 * performs the narrowing would be the one lying about it.
	 */
	let slice = $derived(await fetchSlice(filters.query));
	/**
	 * Blacklisted runs in this slice, whether or not they are currently shown —
	 * `hidden_blacklisted` is 0 by construction while they ARE shown, which made
	 * the toggle read "showing blacklisted (0 runs in this slice)".
	 */
	let sliceBlocked = $derived(slice.n_blacklisted);
	/** Corpus-wide, and labelled as such wherever it appears. */
	let corpusBlocked = $derived(blacklist.n_blocked_runs);
</script>

<div class="bar">
	<div class="row wrap">
		<button class="chip" aria-pressed={open} onclick={() => (open = !open)}>
			Filters{filters.active > 0 ? ` · ${filters.active}` : ''}
		</button>

		{#if blacklist.error !== null}
			<!-- An unreadable blacklist must never render as "nothing is retired" —
			     that is the absent-vs-zero lie, in the dangerous direction. -->
			<span class="badge bad" title="{blacklist.path}: {blacklist.error}">
				⊘ blacklist unreadable — nothing hidden
			</span>
		{:else if sliceBlocked > 0}
			<button
				class="chip"
				aria-pressed={filters.includeBlacklisted}
				title="Configurations with a recorded verdict against them are hidden by default. Their runs are still in the corpus and keep their scores."
				onclick={() => (filters.includeBlacklisted = !filters.includeBlacklisted)}
			>
				⊘ {sliceBlocked} blacklisted run{sliceBlocked === 1 ? '' : 's'}
				{filters.includeBlacklisted ? 'shown' : 'hidden'}
			</button>
		{/if}

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
					disabled={blacklist.error !== null}
					onclick={() => (filters.includeBlacklisted = !filters.includeBlacklisted)}
				>
					{filters.includeBlacklisted ? 'shown' : 'hidden'}
				</button>
				<span class="hint">
					{#if blacklist.error !== null}
						<!-- Not "0 verdicts": the file failed to parse, so how many there are
						     is UNKNOWN. Reporting zero here would read as an all-clear. -->
						{blacklist.path} could not be read, so nothing is hidden and the number of verdicts on record
						is unknown.
					{:else}
						{blacklist.entries.length} verdict{blacklist.entries.length === 1 ? '' : 's'} on record, covering
						{corpusBlocked} run{corpusBlocked === 1 ? '' : 's'} across the corpus{sliceBlocked !==
						corpusBlocked
							? ` (${sliceBlocked} in this slice)`
							: ''}.
					{/if}
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
