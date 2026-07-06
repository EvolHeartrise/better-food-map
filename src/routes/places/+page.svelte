<script lang="ts">
	import BrowseShell from '$lib/components/BrowseShell.svelte';
	import BrowseLinkList from '$lib/components/BrowseLinkList.svelte';
	import { countryLabel } from '$lib/address';
	import { countryPath, PLACES_PATH } from '$lib/browse';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const crumbs = [{ href: resolve('/'), label: 'Map' }];
	const items = $derived(
		data.countries.map((c) => ({
			href: countryPath(c.value),
			label: countryLabel(c.value),
			count: c.count
		}))
	);

	const title = 'Browse food by city';
	const description =
		'Find restaurants, cafés and food spots by country, province and city on BetterFoodMaps.';
	const canonical = `${CANONICAL_ORIGIN}${PLACES_PATH}`;
</script>

<svelte:head>
	<title>{title} - BetterFoodMaps</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
</svelte:head>

<BrowseShell {crumbs} current="Places" {title} intro={description}>
	{#if items.length > 0}
		<BrowseLinkList {items} label="Countries" />
	{:else}
		<p>No coverage yet — check back soon.</p>
	{/if}
</BrowseShell>
