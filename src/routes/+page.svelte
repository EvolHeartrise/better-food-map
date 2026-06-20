<script lang="ts">
	import { resolve } from '$app/paths';
	import { getLocations, getTags } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';

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

	const currency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

	// One entry per location to show, paired with the menu items that matched.
	// Item-level inputs drive the per-card list; with none active, `items` is
	// empty and the card shows no list (the Place box just narrows venues).
	const results = $derived.by(() => {
		const placeTerm = place.trim().toLowerCase();
		const itemTerm = item.trim().toLowerCase();
		const ingredientTerm = ingredient.trim().toLowerCase();

		const hasItemFilter = itemTerm !== '' || ingredientTerm !== '' || selected.length > 0;
		const anyFilter = placeTerm !== '' || hasItemFilter;

		const itemMatches = (menuItem: MenuItem): boolean => {
			if (itemTerm !== '' && !menuItem.item_name.toLowerCase().includes(itemTerm)) return false;
			if (ingredientTerm !== '' && !(menuItem.ingredients ?? '').toLowerCase().includes(ingredientTerm))
				return false;
			if (selected.length > 0) {
				const ids = new Set<string>(menuItem.tags.map((tag) => tag.id));
				if (!selected.every((id) => ids.has(id))) return false;
			}
			return true;
		};

		const out: Array<{ loc: LocationData; items: MenuItem[] }> = [];
		for (const loc of locations) {
			if (!anyFilter) {
				out.push({ loc, items: [] });
				continue;
			}
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

	function toggle(id: string): void {
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}

	function categoryLabel(category: LocationData['category']): string {
		if (!category) return '';
		if (category === 'fast_food') return 'Fast food';
		return category.charAt(0).toUpperCase() + category.slice(1);
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
		<LocationMap locations={mapLocations} />
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
		</div>
	</aside>

	<aside class="panel panel--results" aria-label="Matching places">
		<section class="results">
			<p class="results__count">
				{results.length}
				{results.length === 1 ? 'place' : 'places'}
			</p>

			{#if results.length === 0}
				<p class="results__empty">
					{locations.length === 0 ? 'No places yet.' : 'No matching places.'}
				</p>
			{:else}
				<ul class="results__list">
					{#each results as { loc, items } (loc.id)}
						{@const label = categoryLabel(loc.category)}
						<li>
							<a class="card" href={resolve('/locations/[id]', { id: loc.id })}>
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
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
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
		padding: 0.7rem 0.8rem;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.65);
		border: 1px solid rgba(0, 0, 0, 0.06);
		transition:
			background-color 0.12s,
			border-color 0.12s;
	}

	.card:hover {
		text-decoration: none;
		background: rgba(255, 255, 255, 0.96);
		border-color: var(--color-accent);
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
