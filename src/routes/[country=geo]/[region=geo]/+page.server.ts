// A region index (e.g. /ca/on): the cities we cover in a province/state, linking
// down to each city's venue list. 404 when the (country, region) pair has no
// coverage — which also rejects a valid-looking region that isn't in this
// country. See places/+page.server.ts for why these are `load`s.
import { error } from '@sveltejs/kit';
import { getBrowseCities } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	const country = params.country.toUpperCase();
	const region = params.region.toUpperCase();
	const db = platform?.env?.DB;
	const cities = db ? await getBrowseCities(db, country, region) : [];
	if (cities.length === 0) error(404, 'No such place');
	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return { country, region, cities };
};
