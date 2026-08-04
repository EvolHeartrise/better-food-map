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

<div class="row wrap caveats">
	<span class="muted small">
		{data.counts.runs} runs · {data.counts.tasks} tasks · {data.counts.models} models
	</span>

	{#if data.counts.failed > 0}
		<Badge
			tone="warn"
			label="{data.counts.failed} failed run{data.counts.failed === 1 ? '' : 's'}"
			title="Failed runs produce no report. They are counted, never scored as zero."
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
