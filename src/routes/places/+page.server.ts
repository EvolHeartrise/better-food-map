// The browse tree's root (#217): a crawlable index of the countries we cover,
// linked from the landing footer so the whole geographic tree is reachable from
// `/`. Like the sitemap and the venue gate, these browse pages are a deliberate
// exception to the remote-functions-over-`load` convention (CLAUDE.md): they
// must SSR real <a> links for crawlers, 404 unknown geographies (so the URL
// space stays finite), and set Cache-Control — none of which a remote function
// can do.
import { getBrowseCountries } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, setHeaders }) => {
	const db = platform?.env?.DB;
	const countries = db ? await getBrowseCountries(db) : [];
	// Content page: reusable at the edge for an hour. New coverage appears on the
	// map immediately regardless; the browse index just trails it by up to the TTL.
	setHeaders({ 'cache-control': 'public, max-age=3600' });
	return { countries };
};
