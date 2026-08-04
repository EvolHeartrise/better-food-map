<script lang="ts">
	/**
	 * Shell: header, the one shared filter row, and hash routing.
	 *
	 * Every view gets its data from `$derived(await …)`, so loading and failure are
	 * handled once here by a `<svelte:boundary>` rather than by per-view
	 * `loading`/`error` state. That also buys synchronized updates: when the filter
	 * slice changes, Svelte keeps the current render on screen until the new data
	 * resolves, so refiltering never flashes a skeleton.
	 */
	import FilterBar from './components/FilterBar.svelte';
	import HeaderCaveats from './components/HeaderCaveats.svelte';
	import Compare from './views/Compare.svelte';
	import Frontier from './views/Frontier.svelte';
	import Leaderboard from './views/Leaderboard.svelte';
	import RunDetailView from './views/RunDetail.svelte';
	import Runs from './views/Runs.svelte';
	import Tasks from './views/Tasks.svelte';
	import { router } from './lib/state.svelte';

	const NAV = [
		{ view: 'leaderboard', label: 'Leaderboard' },
		{ view: 'frontier', label: 'Frontier' },
		{ view: 'tasks', label: 'Tasks' },
		{ view: 'runs', label: 'Runs' }
	] as const;

	let view = $derived(router.current.view);
	/** Run detail and compare are their own scope; a global filter there is noise. */
	let showFilters = $derived(view !== 'run' && view !== 'compare');
</script>

<header>
	<div class="bar">
		<h1>Bench analytics</h1>
		<nav class="row">
			{#each NAV as item (item.view)}
				<button class="chip" aria-pressed={view === item.view} onclick={() => router.go(item.view)}
					>{item.label}</button
				>
			{/each}
		</nav>
	</div>

	<svelte:boundary>
		<HeaderCaveats />
		{#snippet pending()}
			<p class="muted small pending">Reading bench runs…</p>
		{/snippet}
		{#snippet failed(error)}
			<p class="error">
				Cannot reach the viewer API ({error instanceof Error ? error.message : String(error)}). Is
				<code>bun run bench:viewer</code> running?
			</p>
		{/snippet}
	</svelte:boundary>
</header>

<main>
	<svelte:boundary>
		{#if showFilters}
			<FilterBar />
		{/if}

		{#if view === 'frontier'}
			<Frontier />
		{:else if view === 'tasks'}
			<Tasks />
		{:else if view === 'runs'}
			<Runs />
		{:else if view === 'run'}
			<RunDetailView />
		{:else if view === 'compare'}
			<Compare />
		{:else}
			<Leaderboard />
		{/if}

		{#snippet pending()}
			<div class="card"><p class="muted">Loading…</p></div>
		{/snippet}

		{#snippet failed(error, reset)}
			<div class="card">
				<h2>Something broke</h2>
				<p class="error">{error instanceof Error ? error.message : String(error)}</p>
				<button class="chip" onclick={reset}>Try again</button>
			</div>
		{/snippet}
	</svelte:boundary>
</main>

<style>
	header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--page);
		border-bottom: 1px solid var(--border);
		padding: 10px 20px;
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	nav {
		gap: 6px;
	}

	.small {
		font-size: 11px;
	}

	.pending {
		margin: 8px 0 0;
	}

	main {
		padding: 16px 20px 48px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 1600px;
	}

	.error {
		color: var(--critical);
		margin: 8px 0 0;
		font-size: 13px;
	}

	code {
		font-family: var(--mono);
		font-size: 12px;
		background: color-mix(in srgb, var(--gridline) 50%, transparent);
		padding: 1px 5px;
		border-radius: 4px;
	}
</style>
