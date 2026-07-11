<script lang="ts">
	import { venueHeadMeta } from '$lib/venue-head';
	import { venueJsonLdScript } from '$lib/venue-jsonld';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { m } from '$lib/paraglide/messages';
	import type { ResolvedLocation } from '$lib/resolve-location';
	import type { Item } from '$lib/server/db';

	// The venue driving the head metadata, or null for the static site-wide head.
	let { venue }: { venue: ResolvedLocation<Item> | null } = $props();

	// Title, description and canonical URL for the venue head (SEO copy lives in
	// $lib/venue-head so scripts/venue-head.test.ts can pin it): the title leads
	// with the city and the description surfaces the menu's dietary coverage
	// (issue #222), and `url` is the canonical descriptive slug (issue #221). Null
	// keeps the static site-wide head.
	const headMeta = $derived(venue ? venueHeadMeta(venue) : null);

	// The schema.org FoodEstablishment JSON-LD for the same venue (issue #218): the
	// structured-data twin of the head copy above, carrying the venue's address,
	// coordinates and full menu (prices + per-item diet suitability) for rich
	// results. A ready-to-inject ld+json script string whose content is escaped in
	// $lib/venue-jsonld so a menu name or description can't break out of the script
	// tag, so the head renders it with {@html}. Null (no venue) keeps the head
	// markup-free.
	const headJsonLd = $derived(venue ? venueJsonLdScript(venue) : null);

	// Open Graph place metadata for the venue (issue #224): a venue page is a
	// physical place, so it declares the OG restaurant vertical (`restaurant.restaurant`,
	// which inherits the `place:location:*` geo properties) instead of the generic
	// `website` type, carrying the venue's exact OSM coordinates. Emitted verbatim,
	// the same coordinates the JSON-LD `geo` node and the map marker use. Null (no
	// open venue) leaves the head on its default `og:type website`.
	const ogPlace = $derived(venue ? { latitude: venue.latitude, longitude: venue.longitude } : null);
</script>

<svelte:head>
	<!-- Warm the tile connection early (issue #224): the map is this route's LCP
	     element, and its vector tiles come from our single self-hosted PMTiles
	     origin, tiles.betterfoodmaps.com (see mapStyle in LocationMap.svelte; the
	     tile URL template is inlined there, so tiles are the origin's FIRST fetch)
	     — a `preconnect` shaves the TLS handshake off it. `crossorigin` matches
	     MapLibre's anonymous CORS tile fetch, so the warmed connection is actually
	     reused. -->
	<link rel="preconnect" href="https://tiles.betterfoodmaps.com" crossorigin="anonymous" />
	{#if headMeta}
		<!-- Venue head for an open location. On a hard /locations/<id> load this is
		     already in the server-rendered HTML (see the landing-venue fetch above),
		     so link unfurlers and crawlers see the venue rather than the site
		     defaults. Svelte escapes text and attribute content here, so the venue
		     fields need no hand-escaping. -->
		<title>{headMeta.title}</title>
		<meta name="description" content={headMeta.description} />
		<!-- The canonicalization signal (og:url is not one): points query-string or
		     stale-slug variants of this venue's URL at the one address the sitemap
		     lists, matching the server's 301 target. -->
		<link rel="canonical" href={headMeta.url} />
		<meta property="og:title" content={headMeta.title} />
		<meta property="og:description" content={headMeta.description} />
		<meta property="og:site_name" content="BetterFoodMaps" />
		<meta property="og:url" content={headMeta.url} />
		<!-- A venue page is a physical place: the OG restaurant vertical (issue #224)
		     carries the venue's exact OSM coordinates for geo-aware unfurlers, and
		     inherits the `place:location:*` properties the generic `website` type
		     lacks. `ogPlace` is non-null here (it derives from the same `headVenue`
		     that gates `headMeta`), so the guard is only for the compiler's null
		     narrowing — the venue head always emits the restaurant vertical. -->
		{#if ogPlace}
			<meta property="og:type" content="restaurant.restaurant" />
			<meta property="place:location:latitude" content={String(ogPlace.latitude)} />
			<meta property="place:location:longitude" content={String(ogPlace.longitude)} />
		{/if}
		<!-- schema.org JSON-LD (issue #218): the machine-readable venue graph
		     crawlers parse for rich results, built in $lib/venue-jsonld and injected
		     raw — its content is escaped there so a menu name or description can't
		     break out of the script tag. -->
		{#if headJsonLd}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html headJsonLd}
		{/if}
	{:else}
		<title>BetterFoodMaps</title>
		<meta name="description" content={m.head_site_description()} />
		<!-- The map root canonicalizes to the bare origin, so query-string variants
		     (shared links, campaign params) don't fragment its indexing. -->
		<link rel="canonical" href="{CANONICAL_ORIGIN}/" />
	{/if}
</svelte:head>
