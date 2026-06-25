<script lang="ts">
	import { getTagSuggestions, searchTags } from '$lib/data.remote';
	import type { Tag } from '$lib/server/db';
	import type { Attachment } from 'svelte/attachments';
	import FoodTag from '$lib/components/FoodTag.svelte';
	import { tagDisplayName } from '$lib/tags';
	import Search from '@lucide/svelte/icons/search';

	// One half of the tag filter: a single searchable list of tags, either the
	// "include" set or the "exclude" set, surfaced to the parent via `bind:selected`.
	// The parent runs two of these side by side and feeds each the union of both
	// sets as `reservedIds`, so a tag already chosen on either side drops out of
	// both dropdowns — that's what keeps include and exclude mutually exclusive
	// without either picker reaching into the other's list. Because the two roles
	// are now separate inputs, there are no per-row +/− controls: a result is just
	// added to *this* picker's set. Selecting is keyboard-first — ↑/↓ moves the
	// highlight, Enter picks — with click/hover as the pointer equivalent.
	let {
		selected = $bindable([]),
		reservedIds,
		mode
	}: {
		selected?: Tag[];
		reservedIds: Set<string>;
		mode: 'include' | 'exclude';
	} = $props();

	const LABEL = $derived(mode === 'include' ? 'Include' : 'Exclude');
	// Visible placeholder. The include picker is the primary filter, so it reads
	// "Filter tags…" rather than "Include tags…"; exclude stays explicit. (The aria
	// labels below keep the precise include/exclude wording for assistive tech.)
	const placeholderText = $derived(mode === 'include' ? 'Filter tags…' : 'Exclude tags…');
	const listId = $derived(`tagpicker-${mode}`);
	const inputId = $derived(`tagpicker-${mode}-input`);
	const optionId = (index: number) => `tagpicker-${mode}-opt-${index}`;
	// The picker's role colour, fed to the portaled result panel as a CSS variable.
	// The panel teleports to <body>, so it can't read `.picker--{mode}` ancestors or
	// the local `--color-exclude`; `--color-accent` is global, the exclude red isn't,
	// so it's inlined here (kept in step with `--color-exclude` in the style block).
	const accentColor = $derived(mode === 'include' ? 'var(--color-accent)' : '#b3261e');

	// Mirrors TAG_SEARCH_LIMIT in $lib/server/db (server-only, so not importable
	// here). Only labels a capped result set; the server stays the source of truth.
	const MAX_RESULTS = 50;
	// Debounce before hitting the server as the user types, so a burst of keystrokes
	// settles into a single search rather than one request per key.
	const SEARCH_DEBOUNCE_MS = 160;

	let open = $state(false);
	let query = $state('');
	// The highlighted option for keyboard navigation; -1 means "nothing highlighted".
	let activeIndex = $state(-1);

	// The default option list, shown before the user types: tags mined from search
	// history for THIS picker's mode — the most-searched tags across all users, with
	// the current user's recently-used tags first (see getTagSuggestions). Read via
	// `.current` so it's non-suspending (the field renders immediately) and updates
	// in place when `logSearch` refreshes the query after a search. May be empty on a
	// fresh database with no matching history yet.
	const suggestionsResource = $derived(getTagSuggestions(mode));
	$effect(() => {
		// Touch the resource so its fetch starts on mount, not on first focus (the
		// list is otherwise only read inside the open dropdown).
		void suggestionsResource.current;
	});
	const suggestions: Tag[] = $derived(suggestionsResource.current ?? []);
	// A tag's position in the suggestion list (lower = more popular / more recent for
	// this user). Used to re-order typed search results so the most-searched matches
	// surface first.
	const suggestionRank: Map<string, number> = $derived(
		new Map(suggestions.map((tag, index) => [tag.id, index]))
	);

	// Server search results for the current (debounced) query, plus the query they
	// were fetched for — so we can tell results that match the current query from a
	// search still in flight (see `displayed` below). The empty query fetches
	// nothing; it shows the suggestion list instead. Results are deliberately NOT
	// cleared between queries, so the last set stays available to display while the
	// next one loads.
	let results = $state<Tag[]>([]);
	let resultsQuery = $state<string | null>(null);
	$effect(() => {
		const q = query.trim();
		// A new query invalidates the old highlight.
		activeIndex = -1;
		if (q === '') return;
		let cancelled = false;
		const timer = setTimeout(() => {
			searchTags(q)
				.then((tags) => {
					if (cancelled) return;
					results = tags;
					resultsQuery = q;
				})
				.catch(() => {
					if (cancelled) return;
					results = [];
					resultsQuery = q;
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	// Typed results, re-ranked by the same popularity/recency signal as the default
	// list (so "the searching process" surfaces most-searched matches first): an
	// exact name match stays pinned to the top — typing a tag's full name should
	// always surface it — then suggested tags by their rank, then the server's own
	// relevance order for the rest (preserved by the stable sort).
	const rankedResults = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === '') return results;
		return results.toSorted((a, b) => {
			const aExact = a.name.toLowerCase() === q ? 0 : 1;
			const bExact = b.name.toLowerCase() === q ? 0 : 1;
			if (aExact !== bExact) return aExact - bExact;
			const aRank = suggestionRank.get(a.id) ?? Number.POSITIVE_INFINITY;
			const bRank = suggestionRank.get(b.id) ?? Number.POSITIVE_INFINITY;
			return aRank - bRank;
		});
	});

	// The list the dropdown actually renders. It's "sticky": when the query changes,
	// the previously shown list stays put and is only swapped once the new data is
	// ready — rather than blanking to a "Searching…"/empty state mid-search. With no
	// query that list is the history-derived suggestions; once the search for the
	// current query has come back, the re-ranked results. While a search is in flight
	// `displayed` is left untouched, so the first keystroke after focus keeps the
	// suggestion list up and refining a search keeps its prior results up, until the
	// new results land.
	let displayed = $state<Tag[]>([]);
	$effect(() => {
		const q = query.trim();
		if (q === '') {
			displayed = suggestions;
		} else if (resultsQuery === q) {
			displayed = rankedResults;
		}
		// else: results for `q` are still loading — leave `displayed` as it is.
	});

	// Tags already chosen on either side (`reservedIds`) are dropped: the picker that
	// holds one shows it as a chip, and the other must not offer it — that mutual
	// exclusion is what keeps include/exclude consistent.
	const options = $derived(displayed.filter((tag) => !reservedIds.has(tag.id)));
	// Distinct from "nothing matched" so the hint can say so rather than mislead.
	const allMatchesReserved = $derived(displayed.length > 0 && options.length === 0);
	// True once the current query's results are in (or there's no query) — lets the
	// "no matches" hint wait for the search instead of flashing before it returns.
	const searchSettled = $derived(query.trim() === '' || resultsQuery === query.trim());
	const capped = $derived(searchSettled && query.trim() !== '' && results.length >= MAX_RESULTS);

	// Each option row carries its tag type as a label to its right, rather than
	// splitting the list into "Dietary" / "Type" / "Ingredients" sections.
	const TYPE_LABEL: Record<Tag['tag_type'], string> = {
		dietary: 'Dietary',
		course: 'Type',
		ingredient: 'Ingredient'
	};

	function selectTag(tag: Tag): void {
		selected = [...selected, tag];
		// Clear the query so the field is ready for the next tag and the dropdown
		// falls back to the suggestion list; keep focus and the panel open.
		query = '';
		activeIndex = -1;
		searchEl?.focus();
	}

	function removeTag(id: string): void {
		selected = selected.filter((tag) => tag.id !== id);
	}

	function clearAll(): void {
		selected = [];
		// Clearing is a reset, not a search action: dismiss the dropdown and drop focus
		// rather than pulling it into the input (which would reopen the panel and raise
		// the mobile keyboard). The explicit blur covers browsers that don't move focus
		// to the Clear button on click, so focus actually leaves the input.
		closePanel();
		searchEl?.blur();
	}

	// --- Keyboard navigation (combobox + listbox aria pattern) ----------------
	// The options aren't focusable; the input keeps focus and points at the active
	// option via `aria-activedescendant`. ↑/↓ move the highlight (wrapping), Enter
	// commits it, and Backspace on an empty query plucks the last chip — the
	// token-field convention.
	function moveActive(delta: number): void {
		if (options.length === 0) {
			activeIndex = -1;
			return;
		}
		const start = activeIndex === -1 && delta < 0 ? 0 : activeIndex;
		activeIndex = (start + delta + options.length) % options.length;
	}

	function onKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				if (!open) openPanel();
				moveActive(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				if (!open) openPanel();
				moveActive(-1);
				break;
			case 'Enter': {
				const tag = options[activeIndex];
				if (tag) {
					event.preventDefault();
					selectTag(tag);
				}
				break;
			}
			case 'Escape':
				event.preventDefault();
				closePanel();
				searchEl?.blur();
				break;
			case 'Backspace':
				if (query === '' && selected.length > 0) {
					event.preventDefault();
					removeTag(selected[selected.length - 1].id);
				}
				break;
		}
	}

	// Keep the highlighted option scrolled into view as ↑/↓ walk past the panel's
	// edge. The panel is portaled under <body>, so resolve the row by id off the
	// document rather than a local query.
	$effect(() => {
		if (!open || activeIndex < 0) return;
		document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
	});

	let rootEl: HTMLElement;
	let fieldEl = $state<HTMLElement>();
	let searchEl = $state<HTMLInputElement>();
	let panelEl = $state<HTMLElement>();

	// Teleport the floating panel to <body> so its `position: fixed` resolves
	// against the viewport — not trapped and clipped by the search bar, whose
	// backdrop-filter makes it the containing block for fixed descendants. The node
	// is stashed in `panelEl` so the outside-pointerdown check can recognise clicks
	// landing inside the portaled panel.
	const portalPanel: Attachment<HTMLElement> = (node) => {
		panelEl = node;
		document.body.appendChild(node);
		return () => {
			node.remove();
			panelEl = undefined;
		};
	};

	// The result panel floats `fixed`, anchored under the whole field (chips
	// included, so it clears them), and mirrors its width. These hold the field's
	// measured viewport position.
	const PANEL_GAP = 4;
	let panelTop = $state(0);
	let panelLeft = $state(0);
	let panelWidth = $state(0);

	function positionPanel(): void {
		if (!fieldEl) return;
		const rect = fieldEl.getBoundingClientRect();
		panelTop = rect.bottom + PANEL_GAP;
		panelLeft = rect.left;
		panelWidth = rect.width;
	}

	function openPanel(): void {
		open = true;
		positionPanel();
	}

	// Closing also clears the query, so the field falls back to its placeholder and
	// a later reopen starts fresh from the suggestion list.
	function closePanel(): void {
		open = false;
		query = '';
		activeIndex = -1;
	}

	// While open: keep the floating panel glued under the field as the page scrolls
	// or resizes, and close on a pointerdown outside the component (or on Escape,
	// handled in onKeyDown). A pointerdown counts as "inside" if it lands on the
	// field/chips (`rootEl`) or the portaled panel (`panelEl`, which lives under
	// <body>, not `rootEl`). A ResizeObserver on the field also reposition the panel
	// when adding/removing chips grows or shrinks the field — its bottom edge moves
	// but no scroll/resize event fires, so the panel would otherwise stay put and
	// overlap the taller field.
	$effect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent): void {
			const target = event.target as Node;
			if (rootEl?.contains(target) || panelEl?.contains(target)) return;
			closePanel();
		}
		function reposition(): void {
			positionPanel();
		}
		const fieldObserver = new ResizeObserver(reposition);
		if (fieldEl) fieldObserver.observe(fieldEl);
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			fieldObserver.disconnect();
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});
</script>

<div class="picker picker--{mode}" bind:this={rootEl}>
	<!-- The field is a token input: chosen tags as removable chips, then the search
	     box. A non-interactive +/− badge states the picker's role even once chips
	     fill the field and the placeholder is gone. It's a <label for> so a click on
	     the field's dead zones (badge, search icon, gaps) focuses the input — the
	     explicit `for` keeps the chips' own buttons from stealing the association. -->
	<label class="picker__field" for={inputId} bind:this={fieldEl}>
		<span class="picker__role" aria-hidden="true">{mode === 'include' ? '+' : '−'}</span>
		{#each selected as tag (tag.id)}
			<span class="chip">
				<FoodTag {tag} />
				<button
					type="button"
					class="chip__remove"
					aria-label={`Remove ${LABEL.toLowerCase()} tag ${tagDisplayName(tag.name)}`}
					onclick={() => removeTag(tag.id)}
				>
					✕
				</button>
			</span>
		{/each}
		<input
			bind:this={searchEl}
			bind:value={query}
			id={inputId}
			type="search"
			class="picker__input"
			placeholder={selected.length === 0 ? placeholderText : ''}
			aria-label={`Search tags to ${mode}`}
			role="combobox"
			aria-expanded={open}
			aria-controls={listId}
			aria-autocomplete="list"
			aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
			onfocus={openPanel}
			onkeydown={onKeyDown}
		/>
		{#if selected.length > 0}
			<button type="button" class="picker__clear" onclick={clearAll}>Clear</button>
		{/if}
		<Search class="picker__icon" size={16} aria-hidden="true" />
	</label>

	{#if open}
		<!-- The result panel: a scrollable listbox floating below the field. Portaled
		     to <body> and positioned `fixed` (anchored to the field, see
		     positionPanel) so it never pushes the search bar's layout and isn't
		     clipped by its overflow / backdrop-filter containing block. -->
		<div
			{@attach portalPanel}
			id={listId}
			class="combo"
			role="listbox"
			aria-label={`${LABEL} tag results`}
			style="top: {panelTop}px; left: {panelLeft}px; width: {panelWidth}px; --picker-accent: {accentColor};"
		>
			{#if options.length === 0}
				<!-- No "Searching…" state: while a search is in flight `displayed` keeps the
				     previous list up, so an empty list here means we've settled on nothing to
				     show. The "no matches" line waits for the search via `searchSettled`, so it
				     can't flash before results return; a pending first search with no list to
				     fall back to simply shows nothing. -->
				{#if allMatchesReserved}
					<p class="combo__hint">Every matching tag is already in your filters.</p>
				{:else if query.trim() === ''}
					<p class="combo__hint">Type to search tags.</p>
				{:else if searchSettled}
					<p class="combo__hint">No tags match your search.</p>
				{/if}
			{:else}
				<ul class="combo__options">
					{#each options as tag, index (tag.id)}
						<!-- A listbox option: not focusable (the input keeps focus and points
						     here via aria-activedescendant). Click/hover mirror Enter/↑↓ for
						     pointer users; keyboard selection is handled on the input. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<li
							id={optionId(index)}
							class="opt"
							class:opt--active={index === activeIndex}
							role="option"
							aria-selected={index === activeIndex}
							onpointerenter={() => (activeIndex = index)}
							onclick={() => selectTag(tag)}
						>
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
	/* A danger hue for the "exclude" picker; the app's accent green carries
	   "include". Kept local — it's the only place the UI expresses negation. */
	.picker {
		--color-exclude: #b3261e;
	}

	/* The token field: a glassy floating pill holding the role badge, the chosen
	   chips and the search input. Mirrors the plain search pills (Place / Item) in
	   the search bar so every floating control reads as one family. */
	.picker__field {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		/* A fixed width (not min/max) so adding chips only ever grows the field
		   vertically — they wrap onto new lines. A flexible width would expand the
		   field horizontally on the first chip and reflow the whole search row. */
		width: 18rem;
		padding: 0.3rem 0.45rem;
		cursor: text;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	.picker--include .picker__field:focus-within {
		border-color: var(--color-accent);
	}

	.picker--exclude .picker__field:focus-within {
		border-color: var(--color-exclude);
	}

	/* A small filled +/− glyph naming the picker's role. Purely decorative (the
	   input's aria-label carries the role for assistive tech); it keeps the field
	   legible as include vs exclude once chips hide the placeholder. */
	.picker__role {
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

	.picker--include .picker__role {
		background-color: var(--color-accent);
	}

	.picker--exclude .picker__role {
		background-color: var(--color-exclude);
	}

	/* A chosen tag: the shared <FoodTag> pill hugged by a thin removable wrapper,
	   tinted by role so include/exclude chips read apart at a glance. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		max-width: 100%;
		padding: 0 0.1rem 0 0;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: rgba(255, 255, 255, 0.6);
	}

	.picker--include .chip {
		border-color: color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	.picker--exclude .chip {
		border-color: color-mix(in srgb, var(--color-exclude) 35%, #fff);
	}

	.chip__remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.05rem;
		height: 1.05rem;
		padding: 0;
		font-size: 0.65rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: none;
		border: none;
		border-radius: 999px;
		cursor: pointer;
	}

	.picker--include .chip__remove:hover {
		color: var(--color-accent);
	}

	.picker--exclude .chip__remove:hover {
		color: var(--color-exclude);
	}

	/* The search box itself: chrome-free so it blends into the token field, which
	   carries the border and background. */
	.picker__input {
		flex: 1;
		min-width: 5rem;
		padding: 0.15rem 0.2rem;
		font: inherit;
		font-size: 0.9rem;
		color: var(--color-text);
		background: none;
		border: none;
		outline: none;
	}

	.picker__input::placeholder {
		color: var(--color-text-muted);
	}

	/* Trailing search glyph, mirroring the plain Place/Item pills. The input's
	   flex-grow keeps it flush at the field's right edge. It renders inside the
	   Lucide child's <svg>, so it's reached with a scoped :global descendant rule. */
	.picker__field :global(.picker__icon) {
		flex-shrink: 0;
		/* Decorative: let clicks fall through to the <label> so it focuses the input. */
		pointer-events: none;
		color: var(--color-text-muted);
	}

	.picker__clear {
		flex-shrink: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.1rem 0.2rem;
		cursor: pointer;
	}

	.picker__clear:hover {
		text-decoration: underline;
	}

	/* The dropdown panel of results. Floated `fixed` over the page (its top/left/
	   width are set inline from the field's measured position) so it never expands
	   the search bar or shifts its layout, and escapes its overflow. Uses the same
	   frosted-glass recipe as the search pills (.searchpill / .picker__field) — same
	   translucency, blur, border and shadow — so the dropdown reads as one family
	   with the field it drops from. */
	.combo {
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
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
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

	/* An option row: the tag pill and, pushed to the trailing edge, its type. The
	   whole row is the click target; the active (keyboard-highlighted or hovered)
	   row is tinted by the picker's role colour. */
	.opt {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.5rem;
		font-size: 0.85rem;
		border-radius: 0.5rem;
		cursor: pointer;
	}

	/* The highlighted row (keyboard ↑/↓ or hover). Driven by `--picker-accent`, set
	   inline on the portaled `.combo` (see accentColor) so the role colour survives
	   the teleport out of `.picker--{mode}`. */
	.opt--active {
		background: color-mix(in srgb, var(--picker-accent) 14%, #fff);
	}

	/* The tag's type, pushed to the row's trailing edge; never shrinks, so the
	   label stays readable. */
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

	/* Roomier tap targets and no iOS auto-zoom (16px input) on touch screens. */
	@media (max-width: 48rem) {
		.picker__input {
			font-size: 1rem;
		}

		.opt {
			padding: 0.5rem 0.5rem;
		}
	}
</style>
