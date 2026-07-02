import * as v from 'valibot';
import { query, getRequestEvent } from '$app/server';
import { requireDb as db } from '$lib/server/context';
import { ttlMemo } from '$lib/server/memo';
import {
	getMapData,
	getLocationMapData,
	getSearchMapData,
	getStats as getStatsFromDb,
	type MapData,
	type MapStats
} from '$lib/server/db';

/**
 * Latitude/longitude schemas shared by the viewport and search-anchor inputs.
 * `v.finite()` rejects `NaN` AND `±Infinity` (plain `v.number()` lets Infinity
 * through), so a malformed coordinate can't reach a D1 range query.
 *
 * Latitude is bounded to [-90, 90]: `currentView()` (LocationMap.svelte) clamps
 * it there even after padding. Longitude is deliberately NOT bounded to
 * [-180, 180] — `currentView()` pads the visible box by 20% per side and leaves
 * longitude unclamped, and MapLibre's `getBounds()` reports unwrapped longitudes
 * beyond ±180 on a zoomed-out globe or an antimeridian-spanning view (the search
 * anchor, a padded-viewport midpoint, inherits the same range). [-540, 540]
 * covers any view the client can produce while still capping hostile input; do
 * not "fix" it to ±180 or world-zoom fetches and searches start 400ing.
 */
const LatitudeSchema = v.pipe(v.number(), v.finite(), v.minValue(-90), v.maxValue(90));
const LongitudeSchema = v.pipe(v.number(), v.finite(), v.minValue(-540), v.maxValue(540));

/**
 * A map viewport (bounding box) the client asks for data within. Validated
 * because `getLocations` is exposed as an HTTP endpoint — the argument arrives
 * untrusted. Ordering is checked too: `currentView()` always emits min <= max
 * (MapLibre's `getBounds()` guarantees south <= north and west <= east, padding
 * is >= 0, and the lat clamp preserves the order), so an inverted box can only
 * be forged input, never a real view.
 */
const BoundsSchema = v.pipe(
	v.object({
		minLat: LatitudeSchema,
		maxLat: LatitudeSchema,
		minLng: LongitudeSchema,
		maxLng: LongitudeSchema
	}),
	v.check((b) => b.minLat <= b.maxLat && b.minLng <= b.maxLng, 'Inverted bounds')
);

/**
 * Returns everything the map page needs for the given viewport (see
 * {@link MapData}): every location inside `bounds` with its own `food` items and
 * per-item overrides, plus each shared brand menu those branches reference,
 * resolved once and keyed by menu_id. The client joins the two to rebuild each
 * location's effective menu, so a chain's shared menu is sent over the wire a
 * single time rather than copied onto every branch. Called again as the user
 * pans/zooms, so only what's on screen is ever fetched. Used to render markers
 * and, under each result, the menu items matching the active search/filter query.
 *
 * Public: the map is open to everyone (no sign-in gate), so this read carries no
 * `requireUser()`. Only the user-scoped functions (likes, saved diet) require auth.
 */
export const getLocations = query(BoundsSchema, async (bounds): Promise<MapData> => {
	return getMapData(db(), bounds);
});

/**
 * Returns a single location (by id) in the same {@link MapData} shape as
 * {@link getLocations}. Backs the detail view when the open location isn't in the
 * current viewport — a shared `/locations/<id>` link, or one panned off screen —
 * so it always resolves. Yields an empty payload if no location has that id.
 * Ids are UUIDs or short slugs; the length cap only rejects hostile payloads.
 */
export const getLocationData = query(
	v.pipe(v.string(), v.maxLength(128)),
	async (id): Promise<MapData> => {
		return getLocationMapData(db(), id);
	}
);

/**
 * A GLOBAL menu search, anchored to the current map centre. Whereas
 * {@link getLocations} is bounded to the viewport, this searches the whole index
 * and returns the matches nearest the anchor (nearest first, same {@link MapData}
 * shape), so an active search is answered from everywhere on the map rather than
 * only what's on screen. `query` is one combined free-text term matched against the
 * venue name OR its item names; the `dietTagId` selector narrows it further. Both
 * mirror the client's own filtering; see {@link getSearchMapData}. Validated
 * because, like every remote query, the argument arrives untrusted over HTTP:
 * the length caps bound what reaches the FTS index (200 far exceeds any real
 * search term; diet tag ids are short fixed tokens), and the anchor reuses the
 * coordinate schemas — see their comment for why `lng` stays loose.
 */
const SearchQuerySchema = v.object({
	query: v.pipe(v.string(), v.maxLength(200)),
	dietTagId: v.nullable(v.pipe(v.string(), v.maxLength(64))),
	lat: LatitudeSchema,
	lng: LongitudeSchema
});

export const searchLocations = query(SearchQuerySchema, async (q): Promise<MapData> => {
	return getSearchMapData(db(), q);
});

/**
 * Aggregate coverage totals (locations, items, cities) for the zoomed-out landing
 * overlay. Public — no sign-in required, and it returns only counts, never any row
 * data.
 *
 * Memoised for 5 minutes: the query behind it is three full-table COUNT scans run
 * for every landing-page visitor, yet the totals only move when data is ingested,
 * so minutes of staleness is invisible on the overlay. The cache is per-isolate
 * (module scope in a Worker isolate — each isolate warms its own copy, eviction
 * resets it), which is fine here: the worst case is one extra scan per isolate
 * per window. `db()` reads the request-scoped event, so it must be resolved
 * inside the memoised fn — safe, because a cache miss only ever happens while a
 * request is being served.
 */
const cachedStats = ttlMemo(5 * 60 * 1000, () => getStatsFromDb(db()));

export const getStats = query((): Promise<MapStats> => {
	const promise = cachedStats();
	// The landing page reads this resource non-suspending, so an SSR render can
	// return before the COUNT scans settle. The Workers runtime then tears down
	// the request's I/O and the memo is left holding a promise that NEVER settles
	// — poisoning every stats consumer (SSR embeds and direct getStats calls
	// alike) for the rest of the TTL window; the landing overlay sits on its
	// placeholder figures the whole time. waitUntil keeps the request context
	// alive until the read completes, so the cached promise always settles.
	// Rejections are swallowed here only for waitUntil's sake — the memo already
	// evicts a rejected entry, and awaiting callers still see the error.
	getRequestEvent().platform?.ctx?.waitUntil(
		promise.then(
			() => undefined,
			() => undefined
		)
	);
	return promise;
});

/**
 * Best-effort opening location for the map, from Cloudflare's edge IP
 * geolocation (`request.cf`). This is prompt-free — unlike the browser
 * Geolocation API, it needs no user permission — at the cost of being only
 * city-level accurate (and skewed by VPNs / mobile carriers).
 *
 * Only the Worker can see `request.cf`, which is why this lives in a remote
 * function rather than on the client. Returns `null` when coordinates are
 * unavailable (notably under local `vite dev`, where the edge metadata is
 * absent); the map falls back to its built-in default view in that case.
 */
export const getUserLocation = query(async (): Promise<{ lat: number; lng: number } | null> => {
	const { platform } = getRequestEvent();
	const cf = platform?.cf;
	// `latitude`/`longitude` arrive as strings; empty/absent values are falsy and
	// short-circuit here, so `Number('')` (which is 0, i.e. the Gulf of Guinea)
	// can never slip through as a real coordinate.
	if (!cf?.latitude || !cf?.longitude) return null;
	const lat = Number(cf.latitude);
	const lng = Number(cf.longitude);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng };
});
