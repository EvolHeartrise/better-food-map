// ---------------------------------------------------------------------------
// Paging primitives for the list_locations MCP tool. Split out of the large
// db-mcp-server.ts into a focused, directly unit-testable module.
//
// list_locations used to return EVERY matching row as a bare JSON array, with no
// cap and no signal that the result was complete — enumerating a big chain by
// brand_id could blow the MCP output cap. These helpers give it the same
// default/max cap + truncation signal every other read tool already has
// (search_poi, audit_locations): a default page of 50, a hard max of 200, and a
// `has_more` flag derived cheaply by over-fetching one row (limit + 1) rather
// than paying for a second COUNT query.
// ---------------------------------------------------------------------------

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, clampLimit } from '../osm/paging';

/** Default page size when the caller passes no `limit`. */
export const LIST_LOCATIONS_DEFAULT_LIMIT = DEFAULT_PAGE_LIMIT;
/** Hard cap on a single page, mirroring search_poi / audit_locations. */
export const LIST_LOCATIONS_MAX_LIMIT = MAX_PAGE_LIMIT;

/**
 * Clamps a requested `limit` to `[1, MAX]`, defaulting to
 * {@link LIST_LOCATIONS_DEFAULT_LIMIT} when absent. A too-large request is
 * clamped (not rejected) so an over-eager caller still gets a valid page.
 */
export function resolveListLimit(limit: number | undefined): number {
	return clampLimit(limit, {
		def: LIST_LOCATIONS_DEFAULT_LIMIT,
		min: 1,
		max: LIST_LOCATIONS_MAX_LIMIT
	});
}

/** Normalizes a requested `offset` to a non-negative integer (default 0). */
export function resolveListOffset(offset: number | undefined): number {
	if (offset === undefined) return 0;
	return Math.max(0, Math.trunc(offset));
}

/** The row-returning list_locations result shape (distinct from count_only's `{ count }`). */
export interface ListLocationsPage<T> {
	locations: T[];
	/** How many rows this page actually carries (`locations.length`). */
	returned: number;
	/** True when more matching rows exist beyond this page. */
	has_more: boolean;
	/** The effective (clamped) page size applied. */
	limit: number;
	/** The effective offset applied. */
	offset: number;
}

/**
 * Assembles the paged result from rows fetched as `limit + 1`. The extra row is
 * the truncation probe: if it came back, more rows exist — so `has_more` is true
 * and the probe is trimmed off. Works for both the SQL path (LIMIT limit + 1)
 * and the in-memory `near` path (slice of limit + 1), so `has_more` never needs a
 * second COUNT query.
 */
export function buildListLocationsPage<T>(
	fetched: T[],
	limit: number,
	offset: number
): ListLocationsPage<T> {
	const hasMore = fetched.length > limit;
	const locations = hasMore ? fetched.slice(0, limit) : fetched;
	return { locations, returned: locations.length, has_more: hasMore, limit, offset };
}
