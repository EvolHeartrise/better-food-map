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
import { ttlMemo } from '$lib/server/memo';

// Like `cachedStats` (data.remote.ts) the cache is per-isolate, and
// `requireDb()` reads the request-scoped event so it must be resolved INSIDE
// the memoised fn — safe, because a cache miss only ever happens while a
// request is being served. A day of staleness merely delays a new venue's
// first crawl.
export const cachedSitemapEntries = ttlMemo(24 * 60 * 60 * 1000, () =>
	getSitemapEntries(requireDb())
);
