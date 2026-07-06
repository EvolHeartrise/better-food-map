import type { ParamMatcher } from '@sveltejs/kit';

/**
 * A geographic code segment for the browse routes (`[country]`, `[region]`): a
 * bare 2-letter lower-case code (`ca`, `on`). Restricting the dynamic segment
 * this tightly keeps the browse routes from swallowing other single-segment
 * paths — `/robots.txt`, `/sitemap.xml`, `/places`, `/auth` all fail to match —
 * and 404s obviously-wrong codes before any load runs. Whether a matching code
 * actually names a covered country/region is decided by the load (it 404s an
 * unknown one).
 */
export const match: ParamMatcher = (value) => /^[a-z]{2}$/.test(value);
