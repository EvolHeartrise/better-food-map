// The sitemap is how crawlers DISCOVER venue pages. `/locations/<id>` URLs are
// synthetic — served by the map page through the reroute in src/hooks.ts — and
// nothing server-renders links to them, so without this file no search engine
// can ever find a venue page. A deliberate exception to the remote-functions-
// over-API-routes convention (CLAUDE.md): crawlers fetch a plain, well-known
// URL, not a SvelteKit remote endpoint, so `/sitemap.xml` must be a real route.
import { requireDb } from '$lib/server/context';
import { getSitemapEntries } from '$lib/server/db';
import { buildSitemapXml } from '$lib/server/sitemap';
import { ttlMemo } from '$lib/server/memo';
import type { RequestHandler } from './$types';

// Memoised for 24h so the full-table read behind the sitemap can't eat D1
// usage: crawlers may refetch this URL as often as they like, but each isolate
// scans the venue table at most once a day. Like `cachedStats` (data.remote.ts)
// the cache is per-isolate, and `requireDb()` reads the request-scoped event so
// it must be resolved INSIDE the memoised fn — safe, because a cache miss only
// ever happens while a request is being served. A day of staleness merely
// delays a new venue's first crawl.
const cachedEntries = ttlMemo(24 * 60 * 60 * 1000, () => getSitemapEntries(requireDb()));

export const GET: RequestHandler = async () => {
	return new Response(buildSitemapXml(await cachedEntries()), {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			// Second caching layer: lets the Cloudflare edge (and crawlers) reuse the
			// response for a day, bounding how often the Worker runs at all.
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
