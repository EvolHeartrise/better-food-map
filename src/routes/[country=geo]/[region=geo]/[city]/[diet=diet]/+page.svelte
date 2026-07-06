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
	import { locationPath } from '$lib/location-path';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const country = $derived(countryLabel(data.country));
	const region = $derived(regionLabel(data.region));
	const place = $derived(`${data.cityName}, ${region}`);
	const dietName = $derived(
		DIETARY_TAGS.find((t) => t.id === data.dietTagId)?.name ?? data.dietTagId
	);

	const crumbs = $derived([
		{ href: resolve('/'), label: 'Map' },
		{ href: PLACES_PATH, label: 'Places' },
		{ href: countryPath(data.country), label: country },
		{ href: regionPath(data.country, data.region), label: region },
		{ href: cityPath(data.country, data.region, data.cityName), label: data.cityName }
	]);

	const items = $derived(
		data.venues.map((v) => ({ href: locationPath(v), label: v.name, sublabel: v.address }))
	);

	const title = $derived(`${dietName} food in ${place}`);
	const description = $derived(
		`${data.venues.length}${data.capped ? '+' : ''} place${data.venues.length === 1 ? '' : 's'} serving ${dietName.toLowerCase()} food in ${place} on BetterFoodMaps.`
	);
	const canonical = $derived(
		`${CANONICAL_ORIGIN}${dietCityPath(data.country, data.region, data.cityName, data.dietTagId)}`
	);
</script>

<svelte:head>
	<title>{title} - BetterFoodMaps</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
</svelte:head>

<BrowseShell {crumbs} current={dietName} {title} intro={description}>
	<BrowseLinkList {items} label="{dietName} places in {data.cityName}" />

	{#if data.capped}
		<p class="cap">Showing the first {data.venues.length} places.</p>
	{/if}
</BrowseShell>

<style>
	.cap {
		margin: 1.25rem 0 0;
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}
</style>
