<script lang="ts">
	import { getTags, searchTags } from '$lib/data.remote';
	import type { Tag } from '$lib/server/db';

	// Two filter lists, surfaced to the parent via `bind:`. `included` tags must
	// all be present on a menu item for it to match; `excluded` tags must all be
	// absent. A tag can be in at most one list (toggling into one removes it from
	// the other). The parent only needs the ids for filtering, but we hold whole
	// Tag objects so a selected chip can render its name without a second lookup —
	// the server search is paged, so the full vocabulary isn't on the client.
	let {
		included = $bindable([]),
		excluded = $bindable([])
	}: { included?: Tag[]; excluded?: Tag[] } = $props();

	// Mirrors TAG_SEARCH_LIMIT in $lib/server/db (a server-only module, so the
	// value can't be imported into this client component). Only used to label a
	// capped result set; the server stays the source of truth.
	const MAX_RESULTS = 50;
	// Debounce before hitting the server as the user types, so a burst of
	// keystrokes settles into a single search rather than one request per key.
	const SEARCH_DEBOUNCE_MS = 160;

	let open = $state(false);
	let query = $state('');

	// The curated dietary/course tags (8 of them), shown as the default option
	// list before the user types. Fetched once; cheap and static server-side.
	let defaultTags = $state<Tag[]>([]);
	$effect(() => {
		getTags().then((tags) => (defaultTags = tags));
	});

	// Server search results for the current (debounced) query. `loading` covers
	// the gap between a keystroke and its results so the list can say so.
	let results = $state<Tag[]>([]);
	let loading = $state(false);
	$effect(() => {
		const q = query.trim();
		if (q === '') {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		let cancelled = false;
		const timer = setTimeout(() => {
			searchTags(q)
				.then((tags) => {
					if (cancelled) return;
					results = tags;
					loading = false;
				})
				.catch(() => {
					if (cancelled) return;
					results = [];
					loading = false;
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	// With no query, offer the curated tags; once searching, the server results.
	const options = $derived(query.trim() === '' ? defaultTags : results);
	const capped = $derived(query.trim() !== '' && results.length >= MAX_RESULTS);

	// Membership lookups for the option rows and selected chips.
	const includedIds = $derived(new Set(included.map((tag) => tag.id)));
	const excludedIds = $derived(new Set(excluded.map((tag) => tag.id)));

	// Group the option list by tag type so the picker reads as a command list
	// with section headings (Dietary / Type / Ingredients), in that order.
	const TYPE_LABEL: Record<Tag['tag_type'], string> = {
		dietary: 'Dietary',
		course: 'Type',
		ingredient: 'Ingredients'
	};
	const TYPE_ORDER: Tag['tag_type'][] = ['dietary', 'course', 'ingredient'];
	const groups = $derived.by(() => {
		// Plain scratch object (not a Map) so the no-mutable-Map lint rule stays
		// happy — it's transient, rebuilt each time, never reactive state.
		const byType: Record<string, Tag[]> = {};
		for (const tag of options) {
			(byType[tag.tag_type] ??= []).push(tag);
		}
		return TYPE_ORDER.filter((type) => byType[type]?.length).map((type) => ({
			type,
			label: TYPE_LABEL[type],
			items: byType[type] ?? []
		}));
	});

	// Ingredient names are stored lower-cased; title-case the first letter so they
	// sit comfortably beside the already-capitalised curated tags ("Vegan").
	function display(tag: Tag): string {
		return tag.name.charAt(0).toUpperCase() + tag.name.slice(1);
	}

	function withoutTag(list: Tag[], id: string): Tag[] {
		return list.filter((tag) => tag.id !== id);
	}

	// Include/exclude are mutually exclusive: toggling a tag into one list drops
	// it from the other. Clicking the active state again clears the tag.
	function toggleInclude(tag: Tag): void {
		if (includedIds.has(tag.id)) {
			included = withoutTag(included, tag.id);
			return;
		}
		excluded = withoutTag(excluded, tag.id);
		included = [...included, tag];
	}

	function toggleExclude(tag: Tag): void {
		if (excludedIds.has(tag.id)) {
			excluded = withoutTag(excluded, tag.id);
			return;
		}
		included = withoutTag(included, tag.id);
		excluded = [...excluded, tag];
	}

	function clearAll(): void {
		included = [];
		excluded = [];
	}

	let rootEl: HTMLElement;
	let searchEl = $state<HTMLInputElement>();

	function openPanel(): void {
		open = true;
	}

	function closePanel(): void {
		open = false;
		query = '';
	}

	function toggleOpen(): void {
		if (open) closePanel();
		else openPanel();
	}

	// While open: focus the search box, and close on a pointerdown anywhere
	// outside the component (the trigger lives inside `rootEl`, so clicking it is
	// "inside" and falls through to its own toggle handler instead of closing).
	$effect(() => {
		if (!open) return;
		searchEl?.focus();
		function onPointerDown(event: PointerEvent): void {
			if (rootEl && !rootEl.contains(event.target as Node)) closePanel();
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => window.removeEventListener('pointerdown', onPointerDown, true);
	});

	const hasSelection = $derived(included.length > 0 || excluded.length > 0);
</script>

<div class="tagfilter" bind:this={rootEl}>
	{#if hasSelection}
		<div class="tagfilter__selected">
			{#each included as tag (tag.id)}
				<button
					type="button"
					class="seltag seltag--include"
					onclick={() => toggleInclude(tag)}
					aria-label={`Remove included tag ${display(tag)}`}
				>
					<span class="seltag__op">is</span>
					<span class="seltag__name">{display(tag)}</span>
					<span class="seltag__x" aria-hidden="true">✕</span>
				</button>
			{/each}
			{#each excluded as tag (tag.id)}
				<button
					type="button"
					class="seltag seltag--exclude"
					onclick={() => toggleExclude(tag)}
					aria-label={`Remove excluded tag ${display(tag)}`}
				>
					<span class="seltag__op">not</span>
					<span class="seltag__name">{display(tag)}</span>
					<span class="seltag__x" aria-hidden="true">✕</span>
				</button>
			{/each}
			<button type="button" class="tagfilter__clear" onclick={clearAll}>Clear</button>
		</div>
	{/if}

	<button
		type="button"
		class="tagfilter__trigger"
		class:tagfilter__trigger--open={open}
		aria-expanded={open}
		aria-haspopup="listbox"
		onclick={toggleOpen}
	>
		<span class="tagfilter__trigger-text">Search tags…</span>
		<span class="tagfilter__chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<!-- The command panel: a search box over a grouped, scrollable result list.
		     Rendered inline (in the panel's scroll flow) rather than floated, so it
		     can never be clipped by the search panel's own overflow. -->
		<div
			class="combo"
			role="group"
			aria-label="Tag search"
			onkeydowncapture={(e) => e.key === 'Escape' && closePanel()}
		>
			<input
				bind:this={searchEl}
				bind:value={query}
				type="search"
				class="combo__search"
				placeholder="Search dietary, type, ingredients…"
				aria-label="Search tags"
			/>

			<div class="combo__list">
				{#if loading && options.length === 0}
					<p class="combo__hint">Searching…</p>
				{:else if options.length === 0}
					<p class="combo__hint">
						{query.trim() === '' ? 'Type to search tags.' : 'No tags match your search.'}
					</p>
				{:else}
					{#each groups as group (group.type)}
						<p class="combo__group">{group.label}</p>
						<ul class="combo__options">
							{#each group.items as tag (tag.id)}
								{@const isIncluded = includedIds.has(tag.id)}
								{@const isExcluded = excludedIds.has(tag.id)}
								<li class="opt" class:opt--included={isIncluded} class:opt--excluded={isExcluded}>
									<button
										type="button"
										class="opt__main"
										aria-pressed={isIncluded}
										onclick={() => toggleInclude(tag)}
									>
										<span class="opt__state" aria-hidden="true">
											{#if isIncluded}✓{:else if isExcluded}✕{/if}
										</span>
										<span class="opt__name">{display(tag)}</span>
									</button>
									<button
										type="button"
										class="opt__exclude"
										aria-pressed={isExcluded}
										aria-label={`Exclude ${display(tag)}`}
										title={isExcluded ? 'Excluded — click to clear' : 'Exclude'}
										onclick={() => toggleExclude(tag)}
									>
										⊘
									</button>
								</li>
							{/each}
						</ul>
					{/each}
					{#if capped}
						<p class="combo__hint">Showing the first {MAX_RESULTS} — keep typing to narrow.</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	/* A danger hue for the "exclude" affordance; the app's accent green carries
	   "include". Kept local — it's the only place the UI expresses negation. */
	.tagfilter {
		--color-exclude: #b3261e;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	/* Selected include/exclude tags, shown as removable chips above the trigger. */
	.tagfilter__selected {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
	}

	.seltag {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		font-weight: 600;
		border-radius: 999px;
		padding: 0.18rem 0.5rem;
		border: 1px solid transparent;
		max-width: 100%;
	}

	.seltag__op {
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.75;
	}

	.seltag__name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.seltag__x {
		font-size: 0.7rem;
		opacity: 0.8;
	}

	.seltag--include {
		color: #fff;
		background-color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.seltag--exclude {
		color: var(--color-exclude);
		background-color: color-mix(in srgb, var(--color-exclude) 10%, #fff);
		border-color: color-mix(in srgb, var(--color-exclude) 35%, #fff);
	}

	.seltag:hover {
		filter: brightness(0.97);
	}

	.tagfilter__clear {
		background: none;
		border: none;
		color: var(--color-accent);
		font-size: 0.78rem;
		font-weight: 600;
		padding: 0.1rem 0.2rem;
	}

	.tagfilter__clear:hover {
		text-decoration: underline;
	}

	/* shadcn-style combobox trigger: a full-width bordered button with a chevron. */
	.tagfilter__trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		padding: 0.45rem 0.7rem;
		font-size: 0.9rem;
		color: var(--color-text-muted);
		background: rgba(255, 255, 255, 0.7);
		border: 1px solid var(--color-border);
		border-radius: 0.6rem;
		text-align: left;
	}

	.tagfilter__trigger:hover {
		border-color: var(--color-accent);
	}

	.tagfilter__trigger--open {
		border-color: var(--color-accent);
	}

	.tagfilter__chev {
		font-size: 0.7rem;
		line-height: 1;
		color: var(--color-text-muted);
	}

	.combo {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.92);
	}

	.combo__search {
		width: 100%;
		padding: 0.4rem 0.6rem;
		font: inherit;
		font-size: 0.88rem;
		color: var(--color-text);
		background: #fff;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		outline: none;
	}

	.combo__search:focus {
		border-color: var(--color-accent);
	}

	.combo__list {
		max-height: 16rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.combo__group {
		margin: 0.35rem 0 0.1rem;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.combo__group:first-child {
		margin-top: 0;
	}

	.combo__options {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.combo__hint {
		margin: 0;
		padding: 0.35rem 0.1rem;
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	/* An option row: a wide "include" toggle plus a trailing "exclude" toggle.
	   They're siblings (not nested buttons) so both stay valid, focusable controls. */
	.opt {
		display: flex;
		align-items: stretch;
		gap: 0.25rem;
		border-radius: 0.5rem;
	}

	.opt__main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.5rem;
		font-size: 0.85rem;
		color: var(--color-text);
		background: none;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		text-align: left;
	}

	.opt__main:hover {
		background: color-mix(in srgb, var(--color-accent) 8%, #fff);
	}

	.opt__state {
		flex-shrink: 0;
		width: 0.9rem;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--color-accent);
		text-align: center;
	}

	.opt__name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.opt__exclude {
		flex-shrink: 0;
		width: 1.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.95rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
	}

	.opt__exclude:hover {
		color: var(--color-exclude);
		border-color: var(--color-exclude);
	}

	.opt--included .opt__main {
		background: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border-color: color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	.opt--excluded .opt__main {
		color: var(--color-text-muted);
		text-decoration: line-through;
	}

	.opt--excluded .opt__state {
		color: var(--color-exclude);
	}

	.opt--excluded .opt__exclude {
		color: #fff;
		background: var(--color-exclude);
		border-color: var(--color-exclude);
	}

	/* Roomier tap targets and no iOS auto-zoom (16px input) on touch screens. */
	@media (max-width: 48rem) {
		.combo__search {
			font-size: 1rem;
		}

		.opt__main {
			padding: 0.5rem;
		}

		.opt__exclude {
			width: 2.2rem;
		}
	}
</style>
