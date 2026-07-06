// A country index (e.g. /ca): the provinces/states we cover, linking down to
// each region. 404 when the code names no covered country (or the D1 binding is
// somehow absent) so the dynamic `[country]` segment can't mint an infinite
// indexable URL space. See places/+page.server.ts for why these are `load`s.
import { error } from '@sveltejs/kit';
import { getBrowseRegions } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	// The `geo` matcher guarantees a 2-letter lower-case code; the stored country
	// is upper-case ISO-2.
	const country = params.country.toUpperCase();
	const db = platform?.env?.DB;
	const regions = db ? await getBrowseRegions(db, country) : [];
	if (regions.length === 0) error(404, 'No such place');
	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return { country, regions };
};
