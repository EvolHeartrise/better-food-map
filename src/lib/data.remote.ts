import { query, getRequestEvent } from '$app/server';
import {
	getLocationsWithMenus,
	getAllTags,
	type D1Like,
	type Tag,
	type LocationWithMenu
} from '$lib/server/db';

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
 * Returns every location merged with its full `menu` (each menu item carries its
 * own dietary tags). Used by the map page to render markers and to show, under
 * each result, the menu items matching the active search/filter query.
 */
export const getLocations = query(async (): Promise<LocationWithMenu[]> => {
	return getLocationsWithMenus(db());
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
