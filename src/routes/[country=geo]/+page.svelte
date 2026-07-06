<script lang="ts">
	import BrowseShell from '$lib/components/BrowseShell.svelte';
	import BrowseLinkList from '$lib/components/BrowseLinkList.svelte';
	import { countryLabel, regionLabel } from '$lib/address';
	import { regionPath, PLACES_PATH } from '$lib/browse';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const country = $derived(countryLabel(data.country));
	const crumbs = $derived([
		{ href: resolve('/'), label: 'Map' },
		{ href: PLACES_PATH, label: 'Places' }
	]);
	const items = $derived(
		data.regions.map((r) => ({
			href: regionPath(data.country, r.value),
			label: regionLabel(r.value),
			count: r.count
		}))
	);

	const title = $derived(`Food in ${country}`);
	const description = $derived(
		`Browse restaurants, cafés and food spots across ${country} by province and city.`
	);
	const canonical = $derived(`${CANONICAL_ORIGIN}/${data.country.toLowerCase()}`);
</script>

<svelte:head>
	<title>{title} - BetterFoodMaps</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
</svelte:head>

<BrowseShell {crumbs} current={country} {title} intro={description}>
	<BrowseLinkList {items} label="Provinces and states" />
</BrowseShell>
