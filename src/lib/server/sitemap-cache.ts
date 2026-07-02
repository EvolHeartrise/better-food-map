// The ONE shared daily cache behind both sitemap routes (`/sitemap.xml` and
// `/sitemaps/<n>.xml`). Paginating the sitemap must not multiply D1 reads —
// bounding them was the point of caching in the first place — so the index
// (page count, per-page lastmod) and every page (its slice) all derive from
// this single cached array: one venue-table scan per isolate per day, total,
// no matter how many sitemap files crawlers fetch. NOTE: this module reaches
// `$app/server` transitively (via requireDb), so tests must not import it —
// they exercise the pure builders in sitemap.ts instead.
import { getRequestEvent } from '$app/server';
import { requireDb } from '$lib/server/context';
import { getSitemapEntries } from '$lib/server/db';
import { ttlMemo } from '$lib/server/memo';
import type { SitemapEntry } from '$lib/server/sitemap';

// Like `cachedStats` (data.remote.ts) the cache is per-isolate, and
// `requireDb()` reads the request-scoped event so it must be resolved INSIDE
// the memoised fn. A day of staleness merely delays a new venue's first crawl.
const memoisedEntries = ttlMemo(24 * 60 * 60 * 1000, () => getSitemapEntries(requireDb()));

export function cachedSitemapEntries(): Promise<SitemapEntry[]> {
	const promise = memoisedEntries();
	// Same hazard `getStats` (data.remote.ts) guards against: the memo caches the
	// PROMISE, and on Workers a cache-miss D1 read is tied to the request that
	// started it. If that request is cancelled mid-read (crawler disconnect, edge
	// timeout) its I/O is torn down and the cached promise never settles —
	// wedging every sitemap route on the isolate for the rest of the 24h TTL.
	// waitUntil keeps the populating request context alive until the read
	// settles. Rejections are swallowed here only for waitUntil's sake — the
	// memo evicts a rejected entry, and awaiting callers still see the error.
	getRequestEvent().platform?.ctx?.waitUntil(
		promise.then(
			() => undefined,
			() => undefined
		)
	);
	return promise;
}
