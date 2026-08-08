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
	import Badge from './Badge.svelte';

	let data = $derived(await fetchOverview());
</script>

<div class="mt-2 flex flex-wrap items-center gap-2">
	<!-- Every number in this bar describes the CORPUS on disk, not the filtered
	     slice below it. Labelled so, because they routinely differ. -->
	<span class="text-[11px] text-muted-foreground">
		corpus: {data.counts.runs} runs · {data.counts.tasks} tasks · {data.counts.models} models
	</span>

	{#if data.counts.failed > 0}
		<!--
			Corpus-wide, like every count in this bar. Said out loud in the label
			because a filter can hide the referent, leaving a reader chasing
			"1 failed run" finding it nowhere on screen.
		-->
		<Badge
			tone="warn"
			label="{data.counts.failed} failed run{data.counts.failed === 1 ? '' : 's'} in corpus"
			title="Failed runs produce no report. They are counted, never scored as zero. This counts the whole corpus — some may be hidden from the current view by a filter."
		/>
	{/if}

	{#if data.unattributed_runs > 0}
		<Badge
			tone="warn"
			label="{data.unattributed_runs} runs without provenance"
			title="These runs predate provider logging. A score without provider and quantization measures model × provider × quantization, not the model."
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

	<span class="text-[11px] text-muted-foreground">reading {data.runs_dir}</span>
</div>
