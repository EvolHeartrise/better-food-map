import * as v from 'valibot';
import { query, getRequestEvent } from '$app/server';
import { requireDb as db } from '$lib/server/context';
import {
	getMapData,
	getLocationMapData,
	getSearchMapData,
	getBrands as getBrandsFromDb,
	getStats as getStatsFromDb,
	type Brand,
	type MapData,
	type MapStats
} from '$lib/server/db';

/**
 * A map viewport (bounding box) the client asks for data within. Validated
 * because `getLocations` is exposed as an HTTP endpoint — the argument arrives
 * untrusted. `v.number()` rejects `NaN`, so a malformed box can't slip through.
 */
const BoundsSchema = v.object({
	minLat: v.number(),
	maxLat: v.number(),
	minLng: v.number(),
	maxLng: v.number()
});

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
 */
export const getLocationData = query(v.string(), async (id): Promise<MapData> => {
	return getLocationMapData(db(), id);
});

/**
 * A GLOBAL menu search, anchored to the current map centre. Whereas
 * {@link getLocations} is bounded to the viewport, this searches the whole index
 * and returns the matches nearest the anchor (nearest first, same {@link MapData}
 * shape), so an active search is answered from everywhere on the map rather than
 * only what's on screen. The free-text and diet filters mirror the client's own
 * filtering; see {@link getSearchMapData}. Validated because, like every remote
 * query, the argument arrives untrusted over HTTP.
 */
const SearchQuerySchema = v.object({
	place: v.string(),
	item: v.string(),
	dietTagId: v.nullable(v.string()),
	lat: v.number(),
	lng: v.number()
});

export const searchLocations = query(SearchQuerySchema, async (q): Promise<MapData> => {
	return getSearchMapData(db(), q);
});

/**
 * Returns every chain/brand (id, name, website, logo). Used by the map page to
 * label deduped chain result groups (e.g. "KFC — 511 locations") with the brand
 * name rather than relying on each branch's own `name`.
 */
export const getBrands = query(async (): Promise<Brand[]> => {
	return getBrandsFromDb(db());
});

/**
 * Aggregate coverage totals (locations, items, cities) for the zoomed-out landing
 * overlay. Public — no sign-in required, and it returns only counts, never any row
 * data.
 */
export const getStats = query((): Promise<MapStats> => getStatsFromDb(db()));

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
