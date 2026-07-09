// The ONE shared daily cache behind both sitemap routes (`/sitemap.xml` and
// `/sitemaps/<n>.xml`). Paginating the sitemap must not multiply D1 reads —
// bounding them was the point of caching in the first place — so the index
// (page count, per-page lastmod) and every page (its slice) all derive from
// this single cached array: one venue-table scan per isolate per day, total,
// no matter how many sitemap files crawlers fetch. NOTE: this module reaches
// `$app/server` transitively (via requireDb), so tests must not import it —
// they exercise the pure builders in sitemap.ts instead.
import { requireDb } from '$lib/server/context';
import { getSitemapEntries } from '$lib/server/db';
import { requestSafeTtlMemo } from '$lib/server/request-memo';
import type { SitemapEntry } from '$lib/server/sitemap';

// Like `cachedStats` (data.remote.ts) the cache is per-isolate, and
// `requireDb()` reads the request-scoped event so it must be resolved INSIDE
// the memoised fn. A day of staleness merely delays a new venue's first crawl.
// A cancelled populating request (crawler disconnect, edge timeout) would wedge
// every sitemap route for the 24h TTL — the never-settling-promise hazard
// `requestSafeTtlMemo` exists to guard against (see its doc comment).
const memoisedEntries = requestSafeTtlMemo(24 * 60 * 60 * 1000, () =>
	getSitemapEntries(requireDb())
);

export function cachedSitemapEntries(): Promise<SitemapEntry[]> {
	return memoisedEntries();
}
