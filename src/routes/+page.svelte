<script lang="ts">
	import { resolve } from '$app/paths';
	import { getLocations } from '$lib/data.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';

	const locations = $derived(await getLocations());

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

	<LocationMap {locations} />

	<section class="listing" aria-label="All locations">
		<h2>All places</h2>

		{#if locations.length === 0}
			<p class="empty">No places yet.</p>
		{:else}
			<ul class="listing__items">
				{#each locations as loc (loc.id)}
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
</style>
