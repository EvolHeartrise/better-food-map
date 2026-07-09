// A city+diet landing page (e.g. /ca/on/toronto/vegan): the open venues in a
// city that serve at least one item matching the diet — the surface built to
// rank for "vegan food in Toronto"-style queries (#217). The diet's satisfying
// tag set (via dietFilterTagIds) mirrors the map's diet filter, so the page and
// the map agree on what counts. 404 when the slug names no city OR the diet has
// no matching venue there (no thin pages). See places/+page.server.ts for why
// these are `load`s.
import { error } from '@sveltejs/kit';
import { getBrowseCities, getBrowseVenuesByDiet, BROWSE_VENUE_LIMIT } from '$lib/server/db';
import { citySlug, dietTagIdFromSlug } from '$lib/browse';
import { dietFilterTagIds } from '$lib/tags';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	const country = params.country.toUpperCase();
	const region = params.region.toUpperCase();
	// The `diet` matcher guarantees this resolves, but re-derive for the tag id.
	const dietTagId = dietTagIdFromSlug(params.diet);
	if (!dietTagId) error(404, 'No such place');

	const db = platform?.env?.DB;
	if (!db) error(404, 'No such place');

	const matches = (await getBrowseCities(db, country, region)).filter(
		(c) => citySlug(c.value) === params.city
	);
	if (matches.length === 0) error(404, 'No such place');
	const cityNames = matches.map((c) => c.value);

	const venues = await getBrowseVenuesByDiet(
		db,
		country,
		region,
		cityNames,
		dietFilterTagIds(dietTagId)
	);
	// An empty diet page is a thin page — 404 rather than hand crawlers a bare list.
	if (venues.length === 0) error(404, 'No such place');

	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return {
		country,
		region,
		cityName: matches[0].value,
		dietTagId,
		venues,
		capped: venues.length >= BROWSE_VENUE_LIMIT
	};
};
