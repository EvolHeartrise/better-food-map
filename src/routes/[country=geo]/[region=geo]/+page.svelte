<script lang="ts">
	import BrowseShell from '$lib/components/BrowseShell.svelte';
	import BrowseLinkList from '$lib/components/BrowseLinkList.svelte';
	import { countryLabel, regionLabel } from '$lib/address';
	import { countryPath, cityPath, PLACES_PATH, mergeCitiesBySlug } from '$lib/browse';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const country = $derived(countryLabel(data.country));
	const region = $derived(regionLabel(data.region));
	const crumbs = $derived([
		{ href: resolve('/'), label: 'Map' },
		{ href: PLACES_PATH, label: 'Places' },
		{ href: countryPath(data.country), label: country }
	]);
	// Merge spellings that slugify to one city page (e.g. "Grand Forks" / "GRAND
	// FORKS") so each city is a single row — a duplicate href would crash the
	// keyed {#each}. See mergeCitiesBySlug.
	const items = $derived(
		mergeCitiesBySlug(data.cities).map((c) => ({
			href: cityPath(data.country, data.region, c.value),
			label: c.value,
			count: c.count
		}))
	);

	const title = $derived(`Food in ${region}, ${country}`);
	const description = $derived(
		`Browse restaurants, cafés and food spots across ${region} by city.`
	);
	const canonical = $derived(
		`${CANONICAL_ORIGIN}/${data.country.toLowerCase()}/${data.region.toLowerCase()}`
	);
</script>

<svelte:head>
	<title>{title} - BetterFoodMaps</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
</svelte:head>

<BrowseShell {crumbs} current={region} {title} intro={description}>
	<BrowseLinkList {items} label="Cities in {region}" />
</BrowseShell>
