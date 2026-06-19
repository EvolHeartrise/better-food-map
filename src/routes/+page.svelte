<script lang="ts">
	import { resolve } from '$app/paths';
	import { getLocations, getTags } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';

	const locations = $derived(await getLocations());
	const allTags = $derived(await getTags());

	// Selected dietary tag ids. A place matches when its menu offers ALL of them.
	let selected = $state<string[]>([]);

	const filtered = $derived(
		selected.length === 0
			? locations
			: locations.filter((loc) => {
					const have = new Set<string>(loc.tags.map((tag) => tag.id));
					return selected.every((id) => have.has(id));
				})
	);

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

<section class="page">
	<header class="page__intro">
		<h1>Better Food Map</h1>
		<p>Explore cafes, fast food and restaurants in Vancouver.</p>
	</header>

	<section class="filters" aria-label="Filter by dietary tag">
		<div class="filters__head">
			<h2 class="filters__title">Dietary filters</h2>
			{#if selected.length > 0}
				<button type="button" class="filters__clear" onclick={() => (selected = [])}>
					Clear all
				</button>
			{/if}
		</div>
		<div class="filters__chips">
			{#each allTags as tag (tag.id)}
				<button
					type="button"
					class="filter"
					class:filter--active={selected.includes(tag.id)}
					aria-pressed={selected.includes(tag.id)}
					onclick={() => toggle(tag.id)}
				>
					{tag.label}
				</button>
			{/each}
		</div>
	</section>

	<LocationMap locations={filtered} />

	<section class="listing" aria-label="All locations">
		<h2>{selected.length > 0 ? 'Matching places' : 'All places'}</h2>

		{#if filtered.length === 0}
			<p class="empty">
				{selected.length > 0 ? 'No places match the selected filters.' : 'No places yet.'}
			</p>
		{:else}
			<ul class="listing__items">
				{#each filtered as loc (loc.id)}
					{@const label = categoryLabel(loc.category)}
					<li class="listing__item">
						<a class="listing__link" href={resolve('/locations/[id]', { id: loc.id })}>{loc.name}</a
						>
						{#if label}
							<span class="listing__category">{label}</span>
						{/if}
						{#if loc.address}
							<span class="listing__address">{loc.address}</span>
						{/if}
						{#if loc.tags.length > 0}
							<ul class="listing__tags">
								{#each loc.tags as tag (tag.id)}
									<li class="listing__tag">{tag.label}</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</section>

<style>
	.page {
		max-width: var(--container-width, 72rem);
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.page__intro p {
		margin: 0;
		color: var(--color-text-muted, #5c5c66);
	}

	.filters {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.filters__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.filters__title {
		margin: 0;
		font-size: 1rem;
	}

	.filters__clear {
		background: none;
		border: none;
		color: var(--color-accent);
		font-size: 0.85rem;
		font-weight: 600;
		padding: 0;
	}

	.filters__clear:hover {
		text-decoration: underline;
	}

	.filters__chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.filter {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-text-muted);
		background-color: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.3rem 0.8rem;
		transition:
			background-color 0.12s,
			color 0.12s,
			border-color 0.12s;
	}

	.filter:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.filter--active {
		color: #fff;
		background-color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.filter--active:hover {
		color: #fff;
		background-color: var(--color-accent-hover);
	}

	.listing h2 {
		margin-bottom: 0.75rem;
	}

	.empty {
		color: var(--color-text-muted, #5c5c66);
	}

	.listing__items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
	}

	.listing__item {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem 1rem;
		background: var(--color-surface, #fff);
		border: 1px solid var(--color-border, #e3e3e8);
		border-radius: var(--radius, 0.5rem);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06));
	}

	.listing__link {
		font-weight: 600;
	}

	.listing__category {
		font-size: 0.85rem;
		color: var(--color-accent, #2f6f4f);
	}

	.listing__address {
		font-size: 0.85rem;
		color: var(--color-text-muted, #5c5c66);
	}

	.listing__tags {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.35rem 0 0;
		padding: 0;
	}

	.listing__tag {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
	}
</style>
