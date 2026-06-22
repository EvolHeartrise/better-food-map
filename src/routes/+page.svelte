<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import { getLocations, getTags, getUserLocation } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import { pointInPolygon, type LatLng } from '$lib/geo';

	const locations = $derived(await getLocations());
	const allTags = $derived(await getTags());

	// Prompt-free IP geolocation from the edge; `null` when unavailable (e.g. local
	// dev), in which case the map opens at its built-in default view.
	const userLocation = $derived(await getUserLocation());
	const initialCenter = $derived<[number, number] | null>(
		userLocation ? [userLocation.lat, userLocation.lng] : null
	);

	type LocationData = (typeof locations)[number];
	type MenuItem = LocationData['menu'][number];

	// Four independent inputs. `place` filters venues by name; `item`, `ingredient`
	// and the `selected` tags filter menu items. They combine with AND.
	let place = $state('');
	let item = $state('');
	let ingredient = $state('');
	let selected = $state<string[]>([]);

	// Optional geographic constraint drawn on the map: a ring of `[lat, lng]`
	// vertices. When set, only venues inside it are shown. `drawing` mirrors the
	// map's draw mode so the panel can show the right controls. Both are bound to
	// <LocationMap>, which owns the actual draw interaction.
	let area = $state<LatLng[] | null>(null);
	let drawing = $state(false);

	// The two floating panels, handed to <LocationMap> so it can frame results into
	// the open space between them rather than underneath them.
	let searchPanelEl = $state<HTMLElement>();
	let resultsPanelEl = $state<HTMLElement>();

	// Reference to the map, used to finish an in-progress area draw from the panel's
	// "Finish area" button — the touch-friendly alternative to tapping the first
	// vertex (or pressing Enter), which is impractical on a phone. `drawPointCount`
	// mirrors how many vertices have been placed so the button enables only once a
	// real polygon (3+ points) is possible.
	let mapComponent = $state<LocationMap>();
	let drawPointCount = $state(0);

	// On narrow (mobile) screens the search panel collapses to a header bar so the
	// map isn't squeezed between it and the results sheet. Open by default so the
	// filters stay discoverable; the toggle (shown only on narrow screens, via CSS)
	// lets the user reclaim the map. The wide layout always shows the controls and
	// hides the toggle, so this flag is inert there.
	let filtersOpen = $state(true);

	const currency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

	// The item-level filters, normalised once. `hasItemFilter` is true when any of
	// them is active; with none active they don't narrow a venue's menu at all.
	// Shared by both the results list and the selected-location menu so the two
	// always agree on what "matches".
	const itemTerm = $derived(item.trim().toLowerCase());
	const ingredientTerm = $derived(ingredient.trim().toLowerCase());
	const hasItemFilter = $derived(itemTerm !== '' || ingredientTerm !== '' || selected.length > 0);

	function itemMatches(menuItem: MenuItem): boolean {
		if (itemTerm !== '' && !menuItem.item_name.toLowerCase().includes(itemTerm)) return false;
		if (
			ingredientTerm !== '' &&
			!(menuItem.ingredients ?? '').toLowerCase().includes(ingredientTerm)
		)
			return false;
		if (selected.length > 0) {
			const ids = new Set<string>(menuItem.tags.map((tag) => tag.id));
			if (!selected.every((id) => ids.has(id))) return false;
		}
		return true;
	}

	// One entry per location to show, paired with the menu items that matched.
	// Item-level inputs drive the per-card list; with none active, `items` is
	// empty and the card shows no list (the Place box just narrows venues).
	const results = $derived.by(() => {
		const placeTerm = place.trim().toLowerCase();
		const areaPoly = area;
		const anyFilter = placeTerm !== '' || hasItemFilter || areaPoly !== null;

		// With every field empty and no area drawn, show no results — the user must
		// search (or draw an area) first.
		if (!anyFilter) return [];

		const out: Array<{ loc: LocationData; items: MenuItem[] }> = [];
		for (const loc of locations) {
			if (areaPoly && !pointInPolygon([loc.latitude, loc.longitude], areaPoly)) continue;
			if (placeTerm !== '' && !loc.name.toLowerCase().includes(placeTerm)) continue;
			if (!hasItemFilter) {
				out.push({ loc, items: [] });
				continue;
			}
			const items = loc.menu.filter(itemMatches);
			if (items.length > 0) {
				out.push({ loc, items });
			}
		}
		return out;
	});

	const mapLocations = $derived(results.map((result) => result.loc));

	// --- Selected location (integrated detail view) ---------------------------
	// The open location is driven by shallow routing: selecting pushes a
	// `/locations/<id>` history entry (without navigating) that carries the id in
	// `page.state`, so Back closes the detail. The record is looked up from the
	// already-loaded `locations`, so no extra fetch is needed.
	//
	// On a fresh load or shared link `page.state` is empty (shallow-routing state
	// isn't restored after a hard navigation), so the id comes from the URL — the
	// `reroute` hook serves this page for `/locations/*`. We snapshot that landing
	// id ONCE instead of reading `page.url` reactively: `pushState`/`replaceState`
	// update only the address bar and `page.state`, never `page.url`. A live
	// `idFromPath(page.url.pathname)` would therefore stay pinned to the landing id
	// for the whole session and re-open the detail every time the selection state
	// is cleared — so closing must also null this snapshot (see `closeDetail`).
	let landingId = $state(idFromPath(page.url.pathname));
	const selectedId = $derived(page.state.selected ?? landingId);
	const selectedLocation = $derived(
		selectedId ? (locations.find((loc) => loc.id === selectedId) ?? null) : null
	);

	// The menu shown in the detail panel for the selected location. The same
	// item/ingredient/dietary filters that narrow the results list apply here too;
	// with none active (`hasItemFilter` false) the full menu is shown.
	const detailMenu = $derived.by<MenuItem[]>(() => {
		if (!selectedLocation) return [];
		if (!hasItemFilter) return selectedLocation.menu;
		return selectedLocation.menu.filter(itemMatches);
	});

	function idFromPath(pathname: string): string | null {
		const match = pathname.match(/\/locations\/([^/]+)$/);
		return match ? decodeURIComponent(match[1]) : null;
	}

	function selectLocation(id: string): void {
		// `/locations/<id>` is a synthetic shallow-routing URL: there is no such
		// route (the `reroute` hook serves this page for it), so the address bar can
		// reflect the open location — and the link stays shareable — without a real
		// navigation. Because it isn't a real route it can't go through the typed
		// `resolve(routeId)`, hence the lint exception on the calls below.
		const url = `/locations/${encodeURIComponent(id)}`;
		const state = { selected: id };
		// Reuse the current history entry when switching between locations, so Back
		// always returns to the results list rather than the previously viewed place.
		if (page.state.selected) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- synthetic shallow URL (see above)
			replaceState(url, state);
		} else {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- synthetic shallow URL (see above)
			pushState(url, state);
		}
	}

	function closeDetail(): void {
		// Drop the landing-id snapshot so a detail opened from a `/locations/<id>`
		// URL actually closes. With `page.state` cleared below, `selectedId` falls
		// back to `landingId`; since `page.url` is frozen at the landing path,
		// `idFromPath` would keep yielding that id, so the snapshot must be cleared
		// too (see the note above the snapshot).
		landingId = null;
		// Rewrite the current history entry to the bare map URL with empty state.
		// `replaceState` clears `page.state` and resets the address bar synchronously;
		// together with the line above, `selectedLocation` resolves to `null` at once.
		//
		// We deliberately avoid `history.back()`: it depends on the previous entry
		// being a selection-free results view and on an async `popstate` to reset
		// `page.state`. Neither holds when the page was opened on a `/locations/<id>`
		// link, so Back there could leave the detail open. Pressing the browser Back
		// button still closes the detail via the prior `/` entry, so back/forward
		// stays intuitive.
		replaceState(resolve('/'), {});
	}

	const hasQuery = $derived(
		place.trim() !== '' ||
			item.trim() !== '' ||
			ingredient.trim() !== '' ||
			selected.length > 0 ||
			area !== null
	);

	function toggle(id: string): void {
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}

	// Starting a draw clears any existing area so the map shows a clean slate;
	// <LocationMap> commits the new ring back to `area` when the user finishes.
	function startAreaDraw(): void {
		area = null;
		drawing = true;
	}

	function cancelAreaDraw(): void {
		drawing = false;
	}

	// Commit the ring from the panel. The map only finishes when 3+ points exist,
	// so this no-ops on a too-small ring (the button is disabled until then anyway).
	function finishAreaDraw(): void {
		mapComponent?.finish();
	}

	function clearArea(): void {
		area = null;
	}

	function categoryLabel(category: LocationData['category']): string {
		if (!category) return '';
		if (category === 'fast_food') return 'Fast food';
		return category.charAt(0).toUpperCase() + category.slice(1);
	}

	function formatPrice(price: number | null): string {
		return price === null ? '—' : currency.format(price);
	}

	// Split the comma-separated ingredient string into trimmed, non-empty parts.
	function ingredientList(ingredients: string | null): string[] {
		if (!ingredients) return [];
		return ingredients
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}

	// A short, readable name for a source: its label, else the bare hostname.
	function sourceText(source: { url: string; label: string | null }): string {
		if (source.label) return source.label;
		try {
			return new URL(source.url).hostname.replace(/^www\./, '');
		} catch {
			return source.url;
		}
	}

	// --- Menu item details popup ----------------------------------------------
	// The menu list shows only name, price and description; hovering a row (or,
	// on touch, tapping it) reveals the full details — dietary tags, ingredients
	// and data sources included — in a popup that floats to the left of the row,
	// over the map. It's rendered once at the page root and positioned `fixed` so
	// it escapes the results panel's `overflow: hidden`.
	const POPUP_GAP = 12;

	let activeMenuItemId = $state<string | null>(null);
	// Coordinates for the wide-screen (left-anchored) layout; ignored when narrow.
	let popupTop = $state(0);
	let popupRight = $state(0);
	let popupEl = $state<HTMLElement>();
	// The row that opened the popup, kept so it can be re-measured on scroll/resize.
	let activeAnchorEl: HTMLElement | null = null;
	// Below 48rem the results panel is a full-width bottom sheet, so there's no
	// room beside a row: the popup switches to a card pinned above the sheet.
	const narrowViewport = new MediaQuery('(max-width: 48rem)');

	const activeMenuItem = $derived(
		activeMenuItemId === null
			? null
			: (detailMenu.find((menuItem) => menuItem.id === activeMenuItemId) ?? null)
	);

	function anchorMenuPopup(anchor: HTMLElement): void {
		activeAnchorEl = anchor;
		const rect = anchor.getBoundingClientRect();
		popupTop = rect.top;
		// The popup's right edge sits a small gap to the left of the row.
		popupRight = window.innerWidth - rect.left + POPUP_GAP;
	}

	function openMenuPopup(id: string, anchor: HTMLElement): void {
		activeMenuItemId = id;
		anchorMenuPopup(anchor);
	}

	function closeMenuPopup(): void {
		activeMenuItemId = null;
		activeAnchorEl = null;
	}

	// Mice hover to open/close; touch is handled by the click toggle below.
	function handleItemPointerEnter(event: PointerEvent, id: string): void {
		if (event.pointerType !== 'mouse') return;
		openMenuPopup(id, event.currentTarget as HTMLElement);
	}

	function handleItemPointerLeave(event: PointerEvent, id: string): void {
		if (event.pointerType !== 'mouse') return;
		if (activeMenuItemId === id) closeMenuPopup();
	}

	// A click — mouse, a tap on touch, or Enter/Space on the button via keyboard
	// — toggles the popup, which is what gives touch users tap-to-open/close.
	function toggleMenuPopup(id: string, anchor: HTMLElement): void {
		if (activeMenuItemId === id) {
			closeMenuPopup();
		} else {
			openMenuPopup(id, anchor);
		}
	}

	// If the open item drops out of the filtered menu (or the detail closes),
	// dismiss its popup.
	$effect(() => {
		if (activeMenuItemId !== null && activeMenuItem === null) closeMenuPopup();
	});

	// Position the wide-screen popup, clamped to stay within the viewport. The
	// floating popup only renders on wide screens — narrow uses an inline expansion
	// under the row — so `popupEl` is absent on narrow and this effect no-ops there.
	$effect(() => {
		const el = popupEl;
		if (!el || activeMenuItemId === null) return;
		const maxTop = window.innerHeight - el.offsetHeight - POPUP_GAP;
		el.style.top = `${Math.max(POPUP_GAP, Math.min(popupTop, maxTop))}px`;
		el.style.right = `${popupRight}px`;
	});

	// Keep the popup glued to its row while the menu list scrolls or the window
	// resizes. The list scrolls inside the panel, hence capture-phase listening.
	$effect(() => {
		if (activeMenuItemId === null) return;
		function reposition() {
			if (activeAnchorEl) anchorMenuPopup(activeAnchorEl);
		}
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});

	// A pointerdown outside the popup and its trigger closes it — this is what
	// lets a tap elsewhere dismiss a tapped-open popup on touch.
	$effect(() => {
		if (activeMenuItemId === null) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Element | null;
			if (popupEl?.contains(target)) return;
			if (target?.closest('.menu__trigger')) return;
			// Taps inside the narrow inline expansion shouldn't dismiss it.
			if (target?.closest('.menu__details')) return;
			closeMenuPopup();
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => window.removeEventListener('pointerdown', onPointerDown, true);
	});
</script>

<svelte:head>
	<title>Better Food Map</title>
	<meta
		name="description"
		content="Explore cafes, fast food and restaurants around the world on an interactive map."
	/>
</svelte:head>

<div class="app">
	<div class="app__map">
		<LocationMap
			bind:this={mapComponent}
			locations={mapLocations}
			selected={selectedLocation}
			onselect={selectLocation}
			obstacles={[searchPanelEl, resultsPanelEl].filter((el) => el !== undefined)}
			{initialCenter}
			bind:polygon={area}
			bind:drawing
			ondrawpoints={(count) => (drawPointCount = count)}
		/>
	</div>

	<aside class="panel panel--search" aria-label="Search and filters" bind:this={searchPanelEl}>
		<header class="panel__brand">
			<a class="panel__title" href={resolve('/')}>Better Food Map</a>
			<!-- Shown only on narrow screens (CSS): collapses the filters to free the map. -->
			<button
				type="button"
				class="panel__toggle"
				aria-expanded={filtersOpen}
				aria-controls="search-controls"
				onclick={() => (filtersOpen = !filtersOpen)}
			>
				<span>{filtersOpen ? 'Hide' : 'Filters'}</span>
				{#if !filtersOpen && hasQuery}
					<span class="panel__toggle-dot" aria-hidden="true"></span>
				{/if}
				<span class="panel__toggle-icon" aria-hidden="true">{filtersOpen ? '▴' : '▾'}</span>
			</button>
		</header>

		<div class="controls" id="search-controls" class:controls--collapsed={!filtersOpen}>
			<!-- Area is a venue-level (geographic) filter, so it's hidden once a single
			     location is pinned — only the menu-item filters below still apply then. -->
			{#if !selectedLocation}
				<div class="field">
					<div class="field__head">
						<span class="field__label" id="q-area">Area</span>
						{#if area && !drawing}
							<button type="button" class="field__clear" onclick={clearArea}>Clear</button>
						{/if}
					</div>

					{#if drawing}
						<p class="area__hint">
							Tap the map to drop points, then Finish. You can also tap the first point or press
							Enter to close the ring; Esc cancels.
						</p>
						<div class="area__actions">
							<button
								type="button"
								class="area__btn area__btn--primary"
								disabled={drawPointCount < 3}
								onclick={finishAreaDraw}
							>
								Finish area
							</button>
							<button type="button" class="area__btn" onclick={cancelAreaDraw}>Cancel</button>
						</div>
					{:else if area}
						<p class="area__status">
							Limited to your drawn area ({area.length}
							{area.length === 1 ? 'point' : 'points'}).
						</p>
						<button type="button" class="area__btn" onclick={startAreaDraw}>Redraw area</button>
					{:else}
						<button type="button" class="area__btn" onclick={startAreaDraw}>Draw area on map</button
						>
					{/if}
				</div>
			{/if}

			<div class="field">
				<span class="field__label" id="q-place-label">Place</span>
				{#if selectedLocation}
					{@const placeLabel = categoryLabel(selectedLocation.category)}
					{@const placeMeta = [placeLabel, selectedLocation.address].filter(Boolean).join(' · ')}
					<div class="place-card" aria-labelledby="q-place-label">
						<div class="place-card__body">
							<span class="place-card__name">{selectedLocation.name}</span>
							{#if placeMeta}
								<span class="place-card__meta">{placeMeta}</span>
							{/if}
						</div>
						<button
							type="button"
							class="place-card__clear"
							aria-label="Clear selected place"
							onclick={closeDetail}
						>
							✕
						</button>
					</div>
				{:else}
					<input
						id="q-place"
						class="field__input"
						type="search"
						placeholder="Place name…"
						aria-labelledby="q-place-label"
						bind:value={place}
					/>
				{/if}
			</div>

			<div class="field">
				<label class="field__label" for="q-item">Item</label>
				<input
					id="q-item"
					class="field__input"
					type="search"
					placeholder="Item name…"
					bind:value={item}
				/>
			</div>

			<div class="field">
				<label class="field__label" for="q-ingredient">Ingredient</label>
				<input
					id="q-ingredient"
					class="field__input"
					type="search"
					placeholder="Ingredient…"
					bind:value={ingredient}
				/>
			</div>

			<div class="field">
				<div class="field__head">
					<span class="field__label" id="q-dietary">Dietary</span>
					{#if selected.length > 0}
						<button type="button" class="field__clear" onclick={() => (selected = [])}>
							Clear
						</button>
					{/if}
				</div>
				<div class="chips" role="group" aria-labelledby="q-dietary">
					{#each allTags as tag (tag.id)}
						<button
							type="button"
							class="chip"
							class:chip--active={selected.includes(tag.id)}
							aria-pressed={selected.includes(tag.id)}
							onclick={() => toggle(tag.id)}
						>
							{tag.label}
						</button>
					{/each}
				</div>
			</div>
		</div>
	</aside>

	<aside
		class="panel panel--results"
		aria-label={selectedLocation ? 'Location details' : 'Matching places'}
		bind:this={resultsPanelEl}
	>
		{#if selectedLocation}
			{@const label = categoryLabel(selectedLocation.category)}
			<section class="detail">
				<button type="button" class="detail__back" onclick={closeDetail}>
					← Back to results
				</button>

				<div class="detail__body">
					<header class="detail__header">
						<h2 class="detail__name">{selectedLocation.name}</h2>
						{#if label}
							<span class="badge">{label}</span>
						{/if}
					</header>

					{#if selectedLocation.address || selectedLocation.phone || selectedLocation.website || selectedLocation.sources.length > 0}
						<dl class="info">
							{#if selectedLocation.address}
								<div class="info__row">
									<dt>Address</dt>
									<dd>{selectedLocation.address}</dd>
								</div>
							{/if}
							{#if selectedLocation.phone}
								<div class="info__row">
									<dt>Phone</dt>
									<dd><a href="tel:{selectedLocation.phone}">{selectedLocation.phone}</a></dd>
								</div>
							{/if}
							{#if selectedLocation.website}
								<div class="info__row">
									<dt>Website</dt>
									<dd>
										<a
											href={selectedLocation.website}
											target="_blank"
											rel="external noopener noreferrer"
										>
											{selectedLocation.website}
										</a>
									</dd>
								</div>
							{/if}
							{#if selectedLocation.sources.length > 0}
								<div class="info__row">
									<dt>Sources</dt>
									<dd>
										<ul class="info__sources">
											{#each selectedLocation.sources as source (source.url)}
												<li>
													<a href={source.url} target="_blank" rel="external noopener noreferrer">
														{sourceText(source)}
													</a>
												</li>
											{/each}
										</ul>
									</dd>
								</div>
							{/if}
						</dl>
					{/if}

					<section class="menu">
						<h3 class="menu__heading">Menu</h3>
						{#if selectedLocation.menu.length === 0}
							<p class="menu__empty">Menu information isn't available for this place yet.</p>
						{:else if detailMenu.length === 0}
							<p class="menu__empty">No menu items match the current filters.</p>
						{:else}
							{#if hasItemFilter}
								<p class="menu__filtered">
									Showing {detailMenu.length} of {selectedLocation.menu.length}
									{selectedLocation.menu.length === 1 ? 'item' : 'items'} matching your filters.
								</p>
							{/if}
							<ul class="menu__list">
								{#each detailMenu as menuItem (menuItem.id)}
									<li class="menu__item">
										<button
											type="button"
											class="menu__trigger"
											aria-expanded={activeMenuItemId === menuItem.id}
											onpointerenter={(event) => handleItemPointerEnter(event, menuItem.id)}
											onpointerleave={(event) => handleItemPointerLeave(event, menuItem.id)}
											onclick={(event) => toggleMenuPopup(menuItem.id, event.currentTarget)}
										>
											<span class="menu__line">
												<span class="menu__name">{menuItem.item_name}</span>
												<span class="menu__price">{formatPrice(menuItem.price)}</span>
											</span>
											{#if menuItem.description}
												<span class="menu__description">{menuItem.description}</span>
											{:else}
												<span class="menu__description menu__description--empty"
													>No description</span
												>
											{/if}
										</button>
										<!-- No room for the floating popup beside the bottom sheet on narrow screens, so the tapped item's details expand inline instead. -->
										{#if narrowViewport.current && activeMenuItemId === menuItem.id}
											<div class="menu__details">
												{@render itemExtras(menuItem)}
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				</div>
			</section>
		{:else}
			<section class="results">
				<p class="results__count">
					{results.length}
					{results.length === 1 ? 'place' : 'places'}
				</p>

				{#if results.length === 0}
					<p class="results__empty">
						{#if locations.length === 0}
							No places yet.
						{:else if hasQuery}
							No matching places.
						{:else}
							Search by place, item, ingredient, or tag to see results.
						{/if}
					</p>
				{:else}
					<ul class="results__list">
						{#each results as { loc, items } (loc.id)}
							{@const label = categoryLabel(loc.category)}
							<li>
								<button type="button" class="card" onclick={() => selectLocation(loc.id)}>
									<span class="card__name">{loc.name}</span>
									{#if label}
										<span class="card__category">{label}</span>
									{/if}
									{#if loc.address}
										<span class="card__address">{loc.address}</span>
									{/if}
									{#if items.length > 0}
										<ul class="card__items">
											{#each items as menuItem (menuItem.id)}
												<li class="card__item">
													<span class="card__item-name">{menuItem.item_name}</span>
													{#if menuItem.price !== null}
														<span class="card__item-price">{currency.format(menuItem.price)}</span>
													{/if}
												</li>
											{/each}
										</ul>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</aside>

	<!-- Shared by the wide-screen floating popup and the narrow inline expansion:
	     the item's tags, ingredients and data sources. -->
	{#snippet itemExtras(menuItem: MenuItem)}
		{@const extraIngredients = ingredientList(menuItem.ingredients)}
		{#if menuItem.tags.length > 0}
			<ul class="tags">
				{#each menuItem.tags as tag (tag.id)}
					<li class="tag">{tag.label}</li>
				{/each}
			</ul>
		{/if}
		{#if extraIngredients.length > 0}
			<ul class="ingredients">
				{#each extraIngredients as ingredient (ingredient)}
					<li class="ingredient">{ingredient}</li>
				{/each}
			</ul>
		{/if}
		{#if menuItem.sources.length > 0}
			<div class="sources">
				<span class="sources__label">Sources</span>
				<ul class="sources__list">
					{#each menuItem.sources as source (source.url)}
						<li class="source">{sourceText(source)}</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/snippet}

	<!-- Wide screens float the details beside the row; narrow screens render them
	     inline under the row (see the menu list above), so this only mounts on wide. -->
	{#if activeMenuItem && !narrowViewport.current}
		<div class="menu-popup" role="tooltip" bind:this={popupEl}>
			<div class="menu__line">
				<span class="menu__name">{activeMenuItem.item_name}</span>
				<span class="menu__price">{formatPrice(activeMenuItem.price)}</span>
			</div>
			{#if activeMenuItem.description}
				<span class="menu__description">{activeMenuItem.description}</span>
			{:else}
				<span class="menu__description menu__description--empty">No description</span>
			{/if}
			{@render itemExtras(activeMenuItem)}
		</div>
	{/if}
</div>

<style>
	.app {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}

	/* The map fills the whole viewport. A z-index here establishes a stacking
	   context so the panel (z-index 10) floats above every Leaflet pane/control. */
	.app__map {
		position: absolute;
		inset: 0;
		z-index: 0;
	}

	/* Both panels are top-aligned and float over the map: search on the left,
	   results on the right. Each is capped to the viewport so it never overflows. */
	.panel {
		position: absolute;
		z-index: 10;
		top: calc(1rem + env(safe-area-inset-top));
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1rem;
		border-radius: 1rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
		max-height: calc(100dvh - 2rem);
	}

	.panel--search {
		left: calc(1rem + env(safe-area-inset-left));
		width: min(20rem, calc(100vw - 2rem));
		overflow-y: auto;
	}

	.panel--results {
		right: calc(1rem + env(safe-area-inset-right));
		width: min(22rem, calc(100vw - 2rem));
		/* The list inside scrolls; the panel itself is clipped. */
		overflow: hidden;
	}

	.panel__brand {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.panel__title {
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--color-text);
		letter-spacing: -0.01em;
	}

	.panel__title:hover {
		text-decoration: none;
		color: var(--color-accent);
	}

	/* Collapse control for the filters. Hidden on wide screens (where the panel
	   always shows its controls); the media query at the bottom reveals it on
	   narrow screens, where folding the panel hands the map back its space. */
	.panel__toggle {
		display: none;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.7);
		color: var(--color-text);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.panel__toggle-icon {
		font-size: 0.7rem;
		line-height: 1;
	}

	/* A small accent dot shown when the panel is collapsed but filters are active,
	   so the user knows a search is still in effect behind the folded panel. */
	.panel__toggle-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--color-accent);
	}

	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.field__label {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.field__input {
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

	.field__input::placeholder {
		color: var(--color-text-muted);
	}

	.field__input:focus {
		border-color: var(--color-accent);
	}

	/* Read-only stand-in for the Place input shown while a location is pinned. The
	   accent tint marks it as an active selection rather than an editable field. */
	.place-card {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border-radius: 0.6rem;
		background: color-mix(in srgb, var(--color-accent) 10%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	.place-card__body {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		flex: 1;
	}

	.place-card__name {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--color-text);
	}

	.place-card__meta {
		font-size: 0.78rem;
		color: var(--color-text-muted);
		word-break: break-word;
	}

	.place-card__clear {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.4rem;
		height: 1.4rem;
		padding: 0;
		font-size: 0.85rem;
		line-height: 1;
		color: var(--color-accent);
		background: rgba(255, 255, 255, 0.6);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.place-card__clear:hover {
		color: #fff;
		background: var(--color-accent);
	}

	.field__clear {
		background: none;
		border: none;
		color: var(--color-accent);
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0;
	}

	.field__clear:hover {
		text-decoration: underline;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.chip {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--color-text-muted);
		background-color: rgba(255, 255, 255, 0.75);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.25rem 0.7rem;
		transition:
			background-color 0.12s,
			color 0.12s,
			border-color 0.12s;
	}

	.chip:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.chip--active {
		color: #fff;
		background-color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.chip--active:hover {
		color: #fff;
		background-color: var(--color-accent-hover);
	}

	.area__btn {
		width: 100%;
		padding: 0.45rem 0.7rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-accent);
		background: rgba(255, 255, 255, 0.7);
		border: 1px solid var(--color-border);
		border-radius: 0.6rem;
		transition:
			background-color 0.12s,
			border-color 0.12s,
			color 0.12s;
	}

	.area__btn:not(:disabled):hover {
		border-color: var(--color-accent);
		background: rgba(255, 255, 255, 0.95);
	}

	.area__btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Finish / Cancel sit side by side while drawing. */
	.area__actions {
		display: flex;
		gap: 0.5rem;
	}

	.area__actions .area__btn {
		flex: 1;
	}

	.area__btn--primary {
		color: #fff;
		background: var(--color-accent);
		border-color: var(--color-accent);
	}

	.area__btn--primary:not(:disabled):hover {
		color: #fff;
		background: var(--color-accent-hover);
		border-color: var(--color-accent-hover);
	}

	.area__hint {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.area__status {
		margin: 0;
		font-size: 0.8rem;
		color: var(--color-text);
	}

	/* Fills remaining panel height; only the list inside it scrolls, so the
	   count label stays pinned without bleeding scrolled cards behind it. */
	.results {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.results__count {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.results__empty {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}

	.results__list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		/* Negative margin lets the scrollbar sit at the panel edge. */
		margin: 0 -0.4rem;
		padding: 0 0.4rem 0.2rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		width: 100%;
		/* Reset the native <button> chrome so the card reads as a list item. */
		appearance: none;
		text-align: left;
		color: inherit;
		padding: 0.7rem 0.8rem;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.65);
		border: 1px solid rgba(0, 0, 0, 0.06);
		transition:
			background-color 0.12s,
			border-color 0.12s;
	}

	.card:hover {
		background: rgba(255, 255, 255, 0.96);
		border-color: var(--color-accent);
	}

	.card:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.card__name {
		font-weight: 600;
		color: var(--color-text);
	}

	.card__category {
		font-size: 0.8rem;
		color: var(--color-accent);
	}

	.card__address {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.card__items {
		list-style: none;
		margin: 0.45rem 0 0;
		padding: 0.45rem 0 0;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.card__item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
		font-size: 0.8rem;
	}

	.card__item-name {
		color: var(--color-text);
	}

	.card__item-price {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* --- Selected-location detail view (replaces the results list) ----------- */
	.detail {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.detail__back {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-accent);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.detail__back:hover {
		text-decoration: underline;
	}

	/* Only the body scrolls; the back button stays pinned at the top. */
	.detail__body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		/* Negative margin lets the scrollbar sit at the panel edge. */
		margin: 0 -0.4rem;
		padding: 0 0.4rem 0.2rem;
	}

	.detail__header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.detail__name {
		margin: 0;
		font-size: 1.15rem;
	}

	.badge {
		display: inline-block;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		background-color: var(--color-accent);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.4;
		white-space: nowrap;
	}

	.info {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0.75rem 0.85rem;
		background: rgba(255, 255, 255, 0.6);
		border: 1px solid var(--color-border);
		border-radius: 0.7rem;
	}

	.info__row {
		display: grid;
		grid-template-columns: 5rem 1fr;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
	}

	.info dt {
		color: var(--color-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.info dd {
		margin: 0;
		font-size: 0.85rem;
		word-break: break-word;
	}

	.info__sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.menu {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.menu__heading {
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
	}

	.menu__empty {
		margin: 0;
		font-size: 0.85rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	.menu__filtered {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.menu__list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.menu__item {
		padding: 0.6rem 0;
		border-bottom: 1px solid rgba(0, 0, 0, 0.08);
	}

	.menu__item:last-child {
		border-bottom: none;
	}

	/* Narrow-screen inline expansion of a tapped item's details (tags, ingredients,
	   sources), shown in place of the wide-screen floating popup. Collapses to
	   nothing when the item has no extra details to show. */
	.menu__details {
		margin: 0.15rem 0 0.1rem;
	}

	.menu__details:empty {
		display: none;
	}

	/* The whole row is a button: hovering or focusing it reveals the details
	   popup, and a click/tap toggles it (the touch path). Styled to read as the
	   plain text row it replaced. */
	.menu__trigger {
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.menu__trigger:hover .menu__name,
	.menu__trigger:focus-visible .menu__name {
		color: var(--color-accent);
	}

	.menu__trigger:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 0.4rem;
	}

	.menu__line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
	}

	.menu__name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.menu__price {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.menu__description {
		display: block;
		margin: 0.3rem 0 0;
		font-size: 0.82rem;
		color: var(--color-text-muted);
	}

	.menu__description--empty {
		font-style: italic;
	}

	.tags {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.4rem 0 0;
		padding: 0;
	}

	.tag {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
	}

	.ingredients {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.35rem 0 0;
		padding: 0;
	}

	.ingredient {
		font-size: 0.72rem;
		color: var(--color-text-muted);
		background-color: rgba(255, 255, 255, 0.6);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
	}

	/* Provenance for the item. The popup is non-interactive (pointer-events: none),
	   so these are shown as plain labels/hostnames rather than clickable links;
	   the interactive location detail panel renders sources as real links. */
	.sources {
		margin: 0.5rem 0 0;
	}

	.sources__label {
		display: block;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	.sources__list {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.25rem 0 0;
		padding: 0;
	}

	.source {
		max-width: 100%;
		overflow: hidden;
		font-size: 0.72rem;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 8%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 25%, #fff);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The details popup floats over the map, to the left of the hovered/tapped
	   row. The positioning effect sets its `top`/`right`; it's non-interactive so
	   it never steals hover from the row or blocks the map beneath it. A touch
	   higher opacity than the panels keeps text legible over the map. */
	.menu-popup {
		position: fixed;
		z-index: 20;
		width: min(18rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		padding: 0.85rem 0.95rem;
		border-radius: 0.85rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 10px 34px rgba(0, 0, 0, 0.22);
		pointer-events: none;
	}

	/* Below ~48rem the two side panels can't sit abreast, so stack them:
	   search across the top, results as a bottom sheet. */
	@media (max-width: 48rem) {
		.panel--search {
			left: calc(1rem + env(safe-area-inset-left));
			right: calc(1rem + env(safe-area-inset-right));
			width: auto;
		}

		.panel--results {
			top: auto;
			bottom: calc(1rem + env(safe-area-inset-bottom));
			left: calc(1rem + env(safe-area-inset-left));
			right: calc(1rem + env(safe-area-inset-right));
			width: auto;
			max-height: 45dvh;
		}

		/* Reveal the collapse toggle, and fold the controls away when collapsed so
		   the panel shrinks to just its header bar — handing the map back its space. */
		.panel__toggle {
			display: inline-flex;
		}

		.controls--collapsed {
			display: none;
		}

		/* 16px inputs stop iOS Safari from auto-zooming the page when one is focused;
		   a touch more padding gives a comfier tap target. */
		.field__input {
			font-size: 1rem;
			padding: 0.55rem 0.7rem;
		}

		/* Roomier tap targets on touch screens. */
		.chip {
			padding: 0.4rem 0.85rem;
			font-size: 0.85rem;
		}

		.field__clear {
			padding: 0.25rem 0.15rem;
		}

		.place-card__clear {
			width: 1.9rem;
			height: 1.9rem;
			font-size: 1rem;
		}
	}
</style>
