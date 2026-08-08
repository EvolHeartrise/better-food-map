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
	import Authoring from './views/Authoring.svelte';
	import Compare from './views/Compare.svelte';
	import Frontier from './views/Frontier.svelte';
	import GoldEditor from './views/GoldEditor.svelte';
	import Leaderboard from './views/Leaderboard.svelte';
	import RunDetailView from './views/RunDetail.svelte';
	import Runs from './views/Runs.svelte';
	import Sources from './views/Sources.svelte';
	import Tasks from './views/Tasks.svelte';
	import { router, type ViewName } from './lib/state.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Tabs from '$lib/components/ui/tabs';

	const NAV = [
		{ view: 'leaderboard', label: 'Leaderboard' },
		{ view: 'frontier', label: 'Frontier' },
		{ view: 'tasks', label: 'Tasks' },
		{ view: 'runs', label: 'Runs' },
		{ view: 'authoring', label: 'Authoring' },
		{ view: 'sources', label: 'Sources' }
	] as const;

	let view = $derived(router.current.view);
	/** Detail views hang off a list view; highlight the parent tab so the nav never goes blank. */
	const NAV_HOME: Partial<Record<ViewName, ViewName>> = {
		run: 'runs',
		compare: 'runs',
		gold: 'authoring'
	};
	let navValue = $derived(NAV_HOME[view] ?? view);
	/**
	 * Run detail and compare are their own scope; a global filter there is noise.
	 * The authoring and sources views are not run-slice views at all (the gold
	 * editor edits one task; sources counts the ingestion stores), so the run
	 * filter bar would imply a narrowing that does not happen.
	 */
	let showFilters = $derived(
		view !== 'run' &&
			view !== 'compare' &&
			view !== 'authoring' &&
			view !== 'gold' &&
			view !== 'sources'
	);
</script>

<header class="sticky top-0 z-10 border-b bg-background px-5 py-2.5">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-lg">Bench analytics</h1>
		<Tabs.Root value={navValue} onValueChange={(next) => router.go(next as ViewName)}>
			<Tabs.List class="h-8">
				{#each NAV as item (item.view)}
					<Tabs.Trigger value={item.view} class="px-2.5 text-xs">{item.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>
	</div>

	<svelte:boundary>
		<HeaderCaveats />
		{#snippet pending()}
			<p class="mt-2 text-[11px] text-muted-foreground">Reading bench runs…</p>
		{/snippet}
		{#snippet failed(error)}
			<p class="mt-2 text-[13px] text-critical">
				Cannot reach the viewer API ({error instanceof Error ? error.message : String(error)}). Is
				<code class="rounded bg-muted px-1 py-px font-mono text-xs">bun run bench:viewer</code> running?
			</p>
		{/snippet}
	</svelte:boundary>
</header>

<main class="flex max-w-[1600px] flex-col gap-4 px-5 pt-4 pb-12">
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
		{:else if view === 'authoring'}
			<Authoring />
		{:else if view === 'gold'}
			<GoldEditor />
		{:else if view === 'sources'}
			<Sources />
		{:else}
			<Leaderboard />
		{/if}

		{#snippet pending()}
			<Card.Root size="sm" class="gap-2">
				<Card.Content class="flex flex-col gap-2">
					<Skeleton class="h-4 w-48" />
					<Skeleton class="h-4 w-80" />
					<Skeleton class="h-4 w-64" />
				</Card.Content>
			</Card.Root>
		{/snippet}

		{#snippet failed(error, reset)}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Something broke</Card.Title>
				</Card.Header>
				<Card.Content class="flex flex-col items-start gap-3">
					<p class="text-[13px] text-critical">
						{error instanceof Error ? error.message : String(error)}
					</p>
					<Button variant="outline" size="sm" onclick={reset}>Try again</Button>
				</Card.Content>
			</Card.Root>
		{/snippet}
	</svelte:boundary>
</main>
