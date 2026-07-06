// A city's venue list (e.g. /ca/on/toronto): every open venue in the city, as
// crawlable links to its /locations/<slug> page — the internal-link surface that
// turns the sitemap's orphan pages into a graph — plus cross-links to the city's
// per-diet pages. The URL carries the city as a slug; since slugifying is lossy,
// the real name is recovered by matching the slug against the region's actual
// cities. 404 when the slug names no city. See places/+page.server.ts for why
// these are `load`s.
import { error } from '@sveltejs/kit';
import {
	getBrowseCities,
	getBrowseVenues,
	getCityDietaryTags,
	BROWSE_VENUE_LIMIT
} from '$lib/server/db';
import { citySlug } from '$lib/browse';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	const country = params.country.toUpperCase();
	const region = params.region.toUpperCase();
	const db = platform?.env?.DB;
	if (!db) error(404, 'No such place');

	// Resolve the slug back to real city name(s). More than one city can slugify to
	// the same value (rare), so match them all and list their venues together; the
	// most-covered spelling (getBrowseCities orders by count desc) names the page.
	const matches = (await getBrowseCities(db, country, region)).filter(
		(c) => citySlug(c.value) === params.city
	);
	if (matches.length === 0) error(404, 'No such place');
	const cityNames = matches.map((c) => c.value);

	const venues = await getBrowseVenues(db, country, region, cityNames);
	const dietTagIds = [...(await getCityDietaryTags(db, country, region, cityNames))];
	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return {
		country,
		region,
		cityName: matches[0].value,
		total: matches.reduce((n, c) => n + c.count, 0),
		venues,
		dietTagIds,
		capped: venues.length >= BROWSE_VENUE_LIMIT
	};
};
