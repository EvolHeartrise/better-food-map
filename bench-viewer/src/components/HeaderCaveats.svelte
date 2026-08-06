<script lang="ts">
	/**
	 * Corpus-level caveats, pinned to the header.
	 *
	 * These belong where every view can see them rather than buried in a detail
	 * page: how many runs failed (they carry no report and are never scored as
	 * zero), how many cannot be attributed to a provider, and any run directory
	 * that would not parse. A dashboard that hides the shape of its own data is
	 * how a confident wrong conclusion gets made.
	 */
	import { fetchOverview } from '../lib/api';
	import { filters } from '../lib/state.svelte';
	import Badge from './Badge.svelte';

	let data = $derived(await fetchOverview(filters.revision));
</script>

<div class="row wrap caveats">
	<!-- Every number in this bar describes the CORPUS on disk, not the filtered
	     slice below it. Labelled so, because they routinely differ. -->
	<span class="muted small">
		corpus: {data.counts.runs} runs · {data.counts.tasks} tasks · {data.counts.models} models
	</span>

	{#if data.counts.failed > 0}
		<!--
			Corpus-wide, like every count in this bar. Said out loud in the label
			because the blacklist filter can hide the referent: the corpus's only
			failed run is a gpt-5.6-luna-pro run, and that model is retired, so by
			default a reader chasing "1 failed run" finds it nowhere on screen.
		-->
		<Badge
			tone="warn"
			label="{data.counts.failed} failed run{data.counts.failed === 1 ? '' : 's'} in corpus"
			title="Failed runs produce no report. They are counted, never scored as zero. This counts the whole corpus — some may be hidden from the current view by a filter or by the blacklist."
		/>
	{/if}

	{#if data.unattributed_runs > 0}
		<Badge
			tone="warn"
			label="{data.unattributed_runs} runs without provenance"
			title="These runs predate provider logging. A score without provider and quantization measures model × provider × quantization, not the model."
		/>
	{/if}

	{#if data.blacklist.error !== null}
		<Badge
			tone="bad"
			label="blacklist unreadable"
			title={`${data.blacklist.path}: ${data.blacklist.error}\n\nNothing is being hidden and edits are disabled. Do not read this dashboard as "no configuration is retired".`}
		/>
	{:else if data.blacklist.n_blocked_runs > 0}
		<!-- The hiding is stated in the header, not only on the control that does
		     it: a reader who never opens the filter bar still has to know the
		     default view is a slice. -->
		<Badge
			tone="neutral"
			label="⊘ {data.blacklist.n_blocked_runs} blacklisted run{data.blacklist.n_blocked_runs === 1
				? ''
				: 's'} {filters.includeBlacklisted ? 'shown' : 'hidden'}"
			title="{data.blacklist.entries
				.length} recorded verdict(s) against tested configurations. Their runs keep their scores; they are just not offered as candidates."
		/>
	{/if}

	{#each data.problems as problem (problem.dir)}
		<Badge tone="bad" label="unreadable: {problem.dir}" title={problem.error} />
	{/each}

	{#if data.counts.runs === 0}
		<Badge
			tone="warn"
			label="no runs found"
			title="bench/ is gitignored, so an empty corpus is expected on a fresh clone."
		/>
	{/if}

	<span class="muted small">reading {data.runs_dir}</span>
</div>

<style>
	.caveats {
		margin-top: 8px;
		gap: 8px;
	}

	.small {
		font-size: 11px;
	}
</style>
