import * as v from 'valibot';
import { query, getRequestEvent } from '$app/server';
import {
	getMapData,
	getLocationMapData,
	getAllTags,
	getBrands as getBrandsFromDb,
	type D1Like,
	type Tag,
	type Brand,
	type MapData
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
 * The request-scoped D1 binding. On Cloudflare it lives on `platform.env.DB`
 * (configured in wrangler.jsonc and emulated locally by the adapter during
 * `vite dev`). Throws a clear error if it is missing rather than failing deep
 * inside a query.
 */
function db(): D1Like {
	const { platform } = getRequestEvent();
	const binding = platform?.env?.DB;
	if (!binding) {
		throw new Error(
			'D1 binding "DB" is not available on platform.env. Check the d1_databases block in ' +
				'wrangler.jsonc and run the app through the Cloudflare adapter (vite dev / wrangler dev).'
		);
	}
	return binding;
}

/**
 * Returns everything the map page needs for the given viewport (see
 * {@link MapData}): every location inside `bounds` with its own `food` items and
 * per-item overrides, plus each shared brand menu those branches reference,
 * resolved once and keyed by menu_id. The client joins the two to rebuild each
 * location's effective menu, so a chain's shared menu is sent over the wire a
 * single time rather than copied onto every branch. Called again as the user
 * pans/zooms, so only what's on screen is ever fetched. Used to render markers
 * and, under each result, the menu items matching the active search/filter query.
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
 * Returns every chain/brand (id, name, website, logo). Used by the map page to
 * label deduped chain result groups (e.g. "KFC — 511 locations") with the brand
 * name rather than relying on each branch's own `name`.
 */
export const getBrands = query(async (): Promise<Brand[]> => {
	return getBrandsFromDb(db());
});

/**
 * Returns the canonical, app-defined dietary tag list. Used to render the
 * filter controls. Tags are not user-authored, so this needs no database read.
 */
export const getTags = query(async (): Promise<Tag[]> => {
	return getAllTags();
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
