// The sitemap is how crawlers DISCOVER venue pages. `/locations/<id>` URLs are
// synthetic — served by the map page through the reroute in src/hooks.ts — and
// nothing server-renders links to them, so without this file no search engine
// can ever find a venue page. A deliberate exception to the remote-functions-
// over-API-routes convention (CLAUDE.md): crawlers fetch a plain, well-known
// URL, not a SvelteKit remote endpoint, so `/sitemap.xml` must be a real route.
//
// The well-known URL now serves a sitemap INDEX referencing the paginated
// urlsets at `/sitemaps/<n>.xml` — the protocol caps a single sitemap file at
// 50k URLs, and swapping an index in at the same address robots.txt has always
// pointed at means scaling past that cap without any crawler-facing URL change.
import { buildSitemapIndexXml } from '$lib/server/sitemap';
import { cachedSitemapEntries } from '$lib/server/sitemap-cache';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return new Response(buildSitemapIndexXml(await cachedSitemapEntries()), {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			// Second caching layer: lets the Cloudflare edge (and crawlers) reuse the
			// response for a day, bounding how often the Worker runs at all.
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
