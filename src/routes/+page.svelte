<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { getLocations, getTags } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import { pointInPolygon, type LatLng } from '$lib/geo';

	const locations = $derived(await getLocations());
	const allTags = $derived(await getTags());

	type LocationData = (typeof locations)[number];
	type MenuItem = LocationData['menu'][number];

	// Four independent inputs. `place` filters venues by name; `item`, `ingredient`
	// and the dietary `selected` tags filter menu items. They combine with AND.
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

	const currency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

	// One entry per location to show, paired with the menu items that matched.
	// Item-level inputs drive the per-card list; with none active, `items` is
	// empty and the card shows no list (the Place box just narrows venues).
	const results = $derived.by(() => {
		const placeTerm = place.trim().toLowerCase();
		const itemTerm = item.trim().toLowerCase();
		const ingredientTerm = ingredient.trim().toLowerCase();

		const areaPoly = area;
		const hasItemFilter = itemTerm !== '' || ingredientTerm !== '' || selected.length > 0;
		const anyFilter = placeTerm !== '' || hasItemFilter || areaPoly !== null;

		// With every field empty and no area drawn, show no results — the user must
		// search (or draw an area) first.
		if (!anyFilter) return [];

		const itemMatches = (menuItem: MenuItem): boolean => {
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
		};

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
	// `page.state`, so Back closes the detail. On a fresh load or shared link
	// `page.state` is empty, so we fall back to the id in the URL — the `reroute`
	// hook serves this page for `/locations/*`. Either way the record is looked up
	// from the already-loaded `locations`, so no extra fetch is needed.
	const selectedId = $derived(page.state.selected ?? idFromPath(page.url.pathname));
	const selectedLocation = $derived(
		selectedId ? (locations.find((loc) => loc.id === selectedId) ?? null) : null
	);

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
		// If we created a history entry, pop it so Back/forward stays consistent;
		// otherwise (landed directly on a /locations/ URL) rewrite to the map.
		if (page.state.selected) history.back();
		else replaceState(resolve('/'), {});
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
</script>

<svelte:head>
	<title>Better Food Map — Vancouver</title>
	<meta
		name="description"
		content="Explore cafes, fast food and restaurants in Vancouver on an interactive map."
	/>
</svelte:head>

<div class="app">
	<div class="app__map">
		<LocationMap
			locations={mapLocations}
			selected={selectedLocation}
			onselect={selectLocation}
			bind:polygon={area}
			bind:drawing
		/>
	</div>

	<aside class="panel panel--search" aria-label="Search and filters">
		<header class="panel__brand">
			<a class="panel__title" href={resolve('/')}>Better Food Map</a>
		</header>

		<div class="controls">
			<div class="field">
				<label class="field__label" for="q-place">Place</label>
				<input
					id="q-place"
					class="field__input"
					type="search"
					placeholder="Place name…"
					bind:value={place}
				/>
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

			<div class="field">
				<div class="field__head">
					<span class="field__label" id="q-area">Area</span>
					{#if area && !drawing}
						<button type="button" class="field__clear" onclick={clearArea}>Clear</button>
					{/if}
				</div>

				{#if drawing}
					<p class="area__hint">
						Click the map to drop points. Click the first point — or press Enter — to finish. Esc
						cancels.
					</p>
					<button type="button" class="area__btn" onclick={cancelAreaDraw}>Cancel drawing</button>
				{:else if area}
					<p class="area__status">
						Limited to your drawn area ({area.length}
						{area.length === 1 ? 'point' : 'points'}).
					</p>
					<button type="button" class="area__btn" onclick={startAreaDraw}>Redraw area</button>
				{:else}
					<button type="button" class="area__btn" onclick={startAreaDraw}>Draw area on map</button>
				{/if}
			</div>
		</div>
	</aside>

	<aside
		class="panel panel--results"
		aria-label={selectedLocation ? 'Location details' : 'Matching places'}
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

					{#if selectedLocation.address || selectedLocation.phone || selectedLocation.website}
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
						</dl>
					{/if}

					<section class="menu">
						<h3 class="menu__heading">Menu</h3>
						{#if selectedLocation.menu.length === 0}
							<p class="menu__empty">Menu information isn't available for this place yet.</p>
						{:else}
							<ul class="menu__list">
								{#each selectedLocation.menu as menuItem (menuItem.id)}
									{@const ingredients = ingredientList(menuItem.ingredients)}
									<li class="menu__item">
										<div class="menu__line">
											<span class="menu__name">{menuItem.item_name}</span>
											<span class="menu__price">{formatPrice(menuItem.price)}</span>
										</div>
										{#if menuItem.description}
											<p class="menu__description">{menuItem.description}</p>
										{/if}
										{#if menuItem.tags.length > 0}
											<ul class="tags">
												{#each menuItem.tags as tag (tag.id)}
													<li class="tag">{tag.label}</li>
												{/each}
											</ul>
										{/if}
										{#if ingredients.length > 0}
											<ul class="ingredients">
												{#each ingredients as ingredient (ingredient)}
													<li class="ingredient">{ingredient}</li>
												{/each}
											</ul>
										{/if}
									</li>
								{/each}
							</ul>
							<p class="menu__note">
								Dietary tags are informational and based on listed ingredients. If you have
								allergies or strict dietary needs, please confirm with the venue.
							</p>
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
							Search by place, item, ingredient, or dietary tag to see results.
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
		top: 1rem;
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
		left: 1rem;
		width: min(20rem, calc(100vw - 2rem));
		overflow-y: auto;
	}

	.panel--results {
		right: 1rem;
		width: min(22rem, calc(100vw - 2rem));
		/* The list inside scrolls; the panel itself is clipped. */
		overflow: hidden;
	}

	.panel__brand {
		display: flex;
		flex-direction: column;
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

	.area__btn:hover {
		border-color: var(--color-accent);
		background: rgba(255, 255, 255, 0.95);
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
		margin: 0.3rem 0 0;
		font-size: 0.82rem;
		color: var(--color-text-muted);
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

	.menu__note {
		margin: 0.75rem 0 0;
		font-size: 0.75rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	/* Below ~48rem the two side panels can't sit abreast, so stack them:
	   search across the top, results as a bottom sheet. */
	@media (max-width: 48rem) {
		.panel--search {
			right: 1rem;
			width: auto;
		}

		.panel--results {
			top: auto;
			bottom: 1rem;
			left: 1rem;
			right: 1rem;
			width: auto;
			max-height: 45dvh;
		}
	}
</style>
