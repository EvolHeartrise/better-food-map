<script lang="ts">
	import { resolve } from '$app/paths';
	import { getLocations, getTags } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';

	const locations = $derived(await getLocations());
	const allTags = $derived(await getTags());

	// Selected dietary tag ids. A place matches when its menu offers ALL of them.
	let selected = $state<string[]>([]);
	// Free-text query matched against name + address (data is already client-side).
	let search = $state('');

	const filtered = $derived.by(() => {
		const term = search.trim().toLowerCase();
		return locations.filter((loc) => {
			if (selected.length > 0) {
				const have = new Set<string>(loc.tags.map((tag) => tag.id));
				if (!selected.every((id) => have.has(id))) return false;
			}
			if (term) {
				const haystack = `${loc.name} ${loc.address ?? ''}`.toLowerCase();
				if (!haystack.includes(term)) return false;
			}
			return true;
		});
	});

	function toggle(id: string): void {
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}

	function categoryLabel(category: (typeof locations)[number]['category']): string {
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
		<LocationMap locations={filtered} />
	</div>

	<aside class="panel" aria-label="Places and filters">
		<header class="panel__brand">
			<a class="panel__title" href={resolve('/')}>Better Food Map</a>
		</header>

		<div class="search">
			<svg class="search__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
				<path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
			<input
				class="search__input"
				type="search"
				placeholder="Search places…"
				bind:value={search}
				aria-label="Search places by name or address"
			/>
		</div>

		<section class="filters" aria-label="Filter by dietary tag">
			<div class="filters__head">
				<span class="filters__title">Dietary</span>
				{#if selected.length > 0}
					<button type="button" class="filters__clear" onclick={() => (selected = [])}>
						Clear
					</button>
				{/if}
			</div>
			<div class="filters__chips">
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
		</section>

		<section class="results" aria-label="Matching places">
			<p class="results__count">
				{filtered.length}
				{filtered.length === 1 ? 'place' : 'places'}
			</p>

			{#if filtered.length === 0}
				<p class="results__empty">
					{locations.length === 0 ? 'No places yet.' : 'No places match your filters.'}
				</p>
			{:else}
				<ul class="results__list">
					{#each filtered as loc (loc.id)}
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
								{#if loc.tags.length > 0}
									<ul class="card__tags">
										{#each loc.tags as tag (tag.id)}
											<li class="card__tag">{tag.label}</li>
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

	.panel {
		position: absolute;
		z-index: 10;
		top: 1rem;
		left: 1rem;
		bottom: 1rem;
		width: min(22rem, calc(100vw - 2rem));
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

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: rgba(255, 255, 255, 0.7);
		border: 1px solid var(--color-border);
		border-radius: 0.7rem;
	}

	.search:focus-within {
		border-color: var(--color-accent);
	}

	.search__icon {
		width: 1.05rem;
		height: 1.05rem;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.search__input {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--color-text);
		outline: none;
	}

	.filters {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.filters__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.filters__title {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.filters__clear {
		background: none;
		border: none;
		color: var(--color-accent);
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0;
	}

	.filters__clear:hover {
		text-decoration: underline;
	}

	.filters__chips {
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

	.card__tags {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.35rem 0 0;
		padding: 0;
	}

	.card__tag {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
	}

	/* On narrow screens the sidebar becomes a bottom panel over the map. */
	@media (max-width: 40rem) {
		.panel {
			top: auto;
			left: 0.5rem;
			right: 0.5rem;
			bottom: 0.5rem;
			width: auto;
			max-height: 55dvh;
		}
	}
</style>
