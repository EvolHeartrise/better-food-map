<script lang="ts">
	import { getTags, searchTags } from '$lib/data.remote';
	import type { Tag } from '$lib/server/db';
	import type { Attachment } from 'svelte/attachments';
	import FoodTag from '$lib/components/FoodTag.svelte';
	import { tagDisplayName } from '$lib/tags';

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

	// Each option row carries its tag type as a label to the right of the tag,
	// rather than splitting the list into "Dietary" / "Type" / "Ingredients"
	// sections. The list stays flat in `options`' natural order — the curated
	// order for the default list, the server's relevance ranking while searching.
	const TYPE_LABEL: Record<Tag['tag_type'], string> = {
		dietary: 'Dietary',
		course: 'Type',
		ingredient: 'Ingredient'
	};

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
	let panelEl = $state<HTMLElement>();

	// Teleport the floating panel to <body> so its `position: fixed` is resolved
	// against the viewport — not trapped and clipped by the search panel, whose
	// backdrop-filter makes it the containing block for fixed descendants. (The
	// menu-item popup in +page.svelte sidesteps the same trap by rendering at the
	// page root.) The node is stashed in `panelEl` so the outside-pointerdown check
	// can recognise clicks landing inside the portaled panel.
	const portalPanel: Attachment<HTMLElement> = (node) => {
		panelEl = node;
		document.body.appendChild(node);
		return () => {
			node.remove();
			panelEl = undefined;
		};
	};

	// The result panel floats `fixed`, anchored under the input, so opening it
	// never expands the search panel or shifts its layout — and so it escapes that
	// panel's `overflow`. These hold the input's measured viewport position; the
	// panel sits just below its lower edge and mirrors its width.
	const PANEL_GAP = 4;
	let panelTop = $state(0);
	let panelLeft = $state(0);
	let panelWidth = $state(0);

	function positionPanel(): void {
		if (!searchEl) return;
		const rect = searchEl.getBoundingClientRect();
		panelTop = rect.bottom + PANEL_GAP;
		panelLeft = rect.left;
		panelWidth = rect.width;
	}

	function openPanel(): void {
		open = true;
		positionPanel();
	}

	// Closing also clears the query, so the always-visible input falls back to its
	// placeholder and a later reopen starts fresh from the curated tag list.
	function closePanel(): void {
		open = false;
		query = '';
	}

	// While open: keep the floating panel glued under the input as the search panel
	// scrolls or the window resizes, and close on a pointerdown outside the
	// component or on Escape. A pointerdown counts as "inside" if it lands on the
	// input/chips (`rootEl`) or the portaled panel (`panelEl`, which lives under
	// <body>, not `rootEl`), so interacting with either leaves the dropdown open.
	// Blurring on Escape lets a later click refocus the input and reopen it. Scroll
	// is captured because the search panel scrolls internally, not the window.
	$effect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent): void {
			const target = event.target as Node;
			if (rootEl?.contains(target) || panelEl?.contains(target)) return;
			closePanel();
		}
		function onKeyDown(event: KeyboardEvent): void {
			if (event.key === 'Escape') {
				closePanel();
				searchEl?.blur();
			}
		}
		function reposition(): void {
			positionPanel();
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
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
					aria-label={`Remove included tag ${tagDisplayName(tag.name)}`}
				>
					<span class="seltag__op">+</span>
					<FoodTag {tag} />
					<span class="seltag__x" aria-hidden="true">✕</span>
				</button>
			{/each}
			{#each excluded as tag (tag.id)}
				<button
					type="button"
					class="seltag seltag--exclude"
					onclick={() => toggleExclude(tag)}
					aria-label={`Remove excluded tag ${tagDisplayName(tag.name)}`}
				>
					<span class="seltag__op">−</span>
					<FoodTag {tag} />
					<span class="seltag__x" aria-hidden="true">✕</span>
				</button>
			{/each}
			<button type="button" class="tagfilter__clear" onclick={clearAll}>Clear</button>
		</div>
	{/if}

	<input
		bind:this={searchEl}
		bind:value={query}
		type="search"
		class="tagfilter__search"
		placeholder="Search tags…"
		aria-label="Search tags"
		role="combobox"
		aria-expanded={open}
		aria-controls="tagfilter-results"
		aria-autocomplete="list"
		onfocus={openPanel}
	/>

	{#if open}
		<!-- The result panel: a grouped, scrollable list floating below the input.
		     Portaled to <body> and positioned `fixed` (anchored to the input, see
		     positionPanel) so it never pushes the search panel's layout and isn't
		     clipped by its overflow / backdrop-filter containing block. -->
		<div
			{@attach portalPanel}
			id="tagfilter-results"
			class="combo__list"
			role="group"
			aria-label="Tag results"
			style="top: {panelTop}px; left: {panelLeft}px; width: {panelWidth}px;"
		>
			{#if loading && options.length === 0}
				<p class="combo__hint">Searching…</p>
			{:else if options.length === 0}
				<p class="combo__hint">
					{query.trim() === '' ? 'Type to search tags.' : 'No tags match your search.'}
				</p>
			{:else}
				<ul class="combo__options">
					{#each options as tag (tag.id)}
						{@const isIncluded = includedIds.has(tag.id)}
						{@const isExcluded = excludedIds.has(tag.id)}
						<li class="opt" class:opt--excluded={isExcluded}>
							<div class="opt__ops">
								<button
									type="button"
									class="opt__op opt__op--include"
									aria-pressed={isIncluded}
									aria-label={`Include ${tagDisplayName(tag.name)}`}
									title={isIncluded ? 'Included — click to clear' : 'Include'}
									onclick={() => toggleInclude(tag)}
								>
									+
								</button>
								<button
									type="button"
									class="opt__op opt__op--exclude"
									aria-pressed={isExcluded}
									aria-label={`Exclude ${tagDisplayName(tag.name)}`}
									title={isExcluded ? 'Excluded — click to clear' : 'Exclude'}
									onclick={() => toggleExclude(tag)}
								>
									−
								</button>
							</div>
							<FoodTag {tag} />
							<span class="opt__type">{TYPE_LABEL[tag.tag_type]}</span>
						</li>
					{/each}
				</ul>
				{#if capped}
					<p class="combo__hint">Showing the first {MAX_RESULTS} — keep typing to narrow.</p>
				{/if}
			{/if}
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

	/* Selected include/exclude tags, shown as removable chips above the input. */
	.tagfilter__selected {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
	}

	/* A selected tag chip wraps a <FoodTag> (the pill) with an operator badge and a
	   remove ✕. The chip itself is a neutral removable button; its include/exclude
	   role is carried by the operator badge's colour and a tinted border, so the
	   FoodTag inside reads the same as it does anywhere else. */
	.seltag {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		max-width: 100%;
		padding: 0.15rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: rgba(255, 255, 255, 0.6);
	}

	/* The +/− operator: a small filled glyph stating the chip's role, echoing the
	   +/− controls in the picker below. */
	.seltag__op {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.05rem;
		height: 1.05rem;
		font-size: 0.85rem;
		font-weight: 700;
		line-height: 1;
		color: #fff;
		border-radius: 999px;
	}

	.seltag__x {
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.seltag--include {
		border-color: color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	.seltag--include .seltag__op {
		background-color: var(--color-accent);
	}

	.seltag--exclude {
		border-color: color-mix(in srgb, var(--color-exclude) 35%, #fff);
	}

	.seltag--exclude .seltag__op {
		background-color: var(--color-exclude);
	}

	.seltag:hover {
		background: rgba(255, 255, 255, 0.85);
	}

	.seltag--include:hover .seltag__x {
		color: var(--color-accent);
	}

	.seltag--exclude:hover .seltag__x {
		color: var(--color-exclude);
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

	/* The real tag search input: a full-width bordered field, styled to match the
	   surrounding filter controls, that opens the result panel below it on focus. */
	.tagfilter__search {
		width: 100%;
		padding: 0.45rem 0.7rem;
		font: inherit;
		font-size: 0.9rem;
		color: var(--color-text);
		background: rgba(255, 255, 255, 0.7);
		border: 1px solid var(--color-border);
		border-radius: 0.6rem;
		outline: none;
	}

	.tagfilter__search::placeholder {
		color: var(--color-text-muted);
	}

	.tagfilter__search:hover,
	.tagfilter__search:focus {
		border-color: var(--color-accent);
	}

	/* The dropdown panel of grouped results. Floated `fixed` over the page (its
	   top/left/width are set inline from the input's measured position) so it never
	   expands the search panel or shifts its layout, and escapes its overflow. The
	   glassy backdrop and shadow match the app's other floating layers. */
	.combo__list {
		position: fixed;
		z-index: 30;
		max-height: 16rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.6);
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
	}

	/* The tag's type, shown to the right of the FoodTag in place of the old
	   per-type section separators. `margin-left: auto` pushes it to the row's
	   trailing edge; it never shrinks, so the label stays readable. */
	.opt__type {
		margin-left: auto;
		flex-shrink: 0;
		padding-left: 0.5rem;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
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

	/* An option row: the include (+) and exclude (−) controls at the left, then the
	   tag pill and its type. The two controls are separate, focusable buttons. */
	.opt {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.85rem;
		border-radius: 0.5rem;
	}

	.opt:hover {
		background: color-mix(in srgb, var(--color-accent) 8%, #fff);
	}

	.opt__ops {
		flex-shrink: 0;
		display: flex;
		gap: 0.2rem;
	}

	/* The +/− buttons. Outlined by default; the active one fills with its colour
	   (accent for include, danger for exclude) to show the current state. */
	.opt__op {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		font-size: 1rem;
		font-weight: 700;
		line-height: 1;
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 0.4rem;
	}

	.opt__op--include {
		color: var(--color-accent);
	}

	.opt__op--include:hover {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 10%, #fff);
	}

	.opt__op--include[aria-pressed='true'] {
		color: #fff;
		background: var(--color-accent);
		border-color: var(--color-accent);
	}

	.opt__op--exclude {
		color: var(--color-exclude);
	}

	.opt__op--exclude:hover {
		border-color: var(--color-exclude);
		background: color-mix(in srgb, var(--color-exclude) 10%, #fff);
	}

	.opt__op--exclude[aria-pressed='true'] {
		color: #fff;
		background: var(--color-exclude);
		border-color: var(--color-exclude);
	}

	/* An excluded row reads as "filtered out": mute its type label (the FoodTag
	   keeps its own colour, and the filled − button marks the state). */
	.opt--excluded {
		color: var(--color-text-muted);
	}

	/* Roomier tap targets and no iOS auto-zoom (16px input) on touch screens. */
	@media (max-width: 48rem) {
		.tagfilter__search {
			font-size: 1rem;
		}

		.opt__op {
			width: 1.9rem;
			height: 1.9rem;
		}
	}
</style>
