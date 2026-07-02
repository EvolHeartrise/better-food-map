import type { ParamMatcher } from '@sveltejs/kit';

/**
 * A positive integer, 1–9999, with no leading zeros: `/sitemaps/01.xml` must
 * 404 rather than serve `/sitemaps/1.xml`'s content under a duplicate URL.
 */
export const match: ParamMatcher = (value) => /^[1-9]\d{0,3}$/.test(value);
