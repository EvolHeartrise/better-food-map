<script lang="ts">
	import BrowseShell from '$lib/components/BrowseShell.svelte';
	import BrowseLinkList from '$lib/components/BrowseLinkList.svelte';
	import { countryLabel, regionLabel } from '$lib/address';
	import {
		countryPath,
		regionPath,
		cityPath,
		dietCityPath,
		DIETARY_TAGS,
		PLACES_PATH
	} from '$lib/browse';
	import { dietFilterTagIds } from '$lib/tags';
	import { locationPath } from '$lib/location-path';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const country = $derived(countryLabel(data.country));
	const region = $derived(regionLabel(data.region));
	const place = $derived(`${data.cityName}, ${region}`);

	const crumbs = $derived([
		{ href: resolve('/'), label: 'Map' },
		{ href: PLACES_PATH, label: 'Places' },
		{ href: countryPath(data.country), label: country },
		{ href: regionPath(data.country, data.region), label: region }
	]);

	// One /locations/<slug> link per venue (built through the same locationPath the
	// venue's own canonical URL uses, so a browse link lands on the canonical page
	// with no redirect), name + address.
	const items = $derived(
		data.venues.map((v) => ({ href: locationPath(v), label: v.name, sublabel: v.address }))
	);

	// Per-diet cross-links for exactly the diets whose page would have matches —
	// i.e. a diet whose satisfying tag set (the diet plus any tag entailing it,
	// e.g. Vegan satisfies the Vegetarian/Dairy-free filters) intersects the
	// dietary tags actually present in this city. This mirrors the diet page's own
	// membership (via dietFilterTagIds), so every linked diet is a real, non-thin
	// page and none is missed.
	const presentTags = $derived(new Set(data.dietTagIds));
	const dietLinks = $derived(
		DIETARY_TAGS.filter((t) => dietFilterTagIds(t.id).some((id) => presentTags.has(id))).map(
			(t) => ({
				href: dietCityPath(data.country, data.region, data.cityName, t.id),
				label: t.name
			})
		)
	);

	const title = $derived(`Food in ${place}`);
	const description = $derived(
		`${data.total} restaurant${data.total === 1 ? '' : 's'}, café${data.total === 1 ? '' : 's'} and food spots in ${place} — with menus and dietary options on BetterFoodMaps.`
	);
	const canonical = $derived(
		`${CANONICAL_ORIGIN}${cityPath(data.country, data.region, data.cityName)}`
	);
</script>

<svelte:head>
	<title>{title} - BetterFoodMaps</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
</svelte:head>

<BrowseShell {crumbs} current={data.cityName} {title} intro={description}>
	{#if dietLinks.length > 0}
		<nav class="diets" aria-label="Diets in {data.cityName}">
			{#each dietLinks as link (link.href)}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pre-built internal href ($lib/browse); no base path — see +page.svelte precedent -->
				<a class="diets__link" href={link.href}>{link.label}</a>
			{/each}
		</nav>
	{/if}

	<BrowseLinkList {items} label="Places in {data.cityName}" />

	{#if data.capped}
		<p class="cap">Showing the first {data.venues.length} places in {place}.</p>
	{/if}
</BrowseShell>

<style>
	/* A wrapping row of diet chips linking to this city's per-diet pages. */
	.diets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0 0 1.5rem;
	}

	.diets__link {
		padding: 0.3rem 0.7rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
		border-radius: 999px;
	}

	.diets__link:hover {
		text-decoration: none;
		background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface));
	}

	.cap {
		margin: 1.25rem 0 0;
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}
</style>
