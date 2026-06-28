import * as v from 'valibot';
import { query, getRequestEvent } from '$app/server';
import { requireDb as db, requireUser } from '$lib/server/context';
import {
	getMapData,
	getLocationMapData,
	getSearchMapData,
	searchTagVocabulary,
	getTagSuggestions as getTagSuggestionsFromDb,
	getBrands as getBrandsFromDb,
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
	requireUser();
	return getMapData(db(), bounds);
});

/**
 * Returns a single location (by id) in the same {@link MapData} shape as
 * {@link getLocations}. Backs the detail view when the open location isn't in the
 * current viewport — a shared `/locations/<id>` link, or one panned off screen —
 * so it always resolves. Yields an empty payload if no location has that id.
 */
export const getLocationData = query(v.string(), async (id): Promise<MapData> => {
	requireUser();
	return getLocationMapData(db(), id);
});

/**
 * A GLOBAL menu search, anchored to the current map centre. Whereas
 * {@link getLocations} is bounded to the viewport, this searches the whole index
 * and returns the matches nearest the anchor (nearest first, same {@link MapData}
 * shape), so an active search is answered from everywhere on the map rather than
 * only what's on screen. The free-text and tag filters mirror the client's own
 * filtering; see {@link getSearchMapData}. Validated because, like every remote
 * query, the argument arrives untrusted over HTTP.
 */
const SearchQuerySchema = v.object({
	place: v.string(),
	item: v.string(),
	includedTagIds: v.array(v.string()),
	excludedTagIds: v.array(v.string()),
	lat: v.number(),
	lng: v.number()
});

export const searchLocations = query(SearchQuerySchema, async (q): Promise<MapData> => {
	requireUser();
	return getSearchMapData(db(), q);
});

/**
 * Returns every chain/brand (id, name, website, logo). Used by the map page to
 * label deduped chain result groups (e.g. "KFC — 511 locations") with the brand
 * name rather than relying on each branch's own `name`.
 */
export const getBrands = query(async (): Promise<Brand[]> => {
	requireUser();
	return getBrandsFromDb(db());
});

/**
 * Searches the full tag vocabulary (curated dietary/course tags AND the
 * ingredient tags created from item data) by name substring, ranked and capped
 * (see {@link searchTagVocabulary}). Backs the tag filter's searchable picker:
 * the ingredient vocabulary is thousands of rows, so it is searched on the
 * server per keystroke rather than shipped to the client. An empty query yields
 * the curated tags.
 */
export const searchTags = query(v.string(), async (q): Promise<Tag[]> => {
	requireUser();
	return searchTagVocabulary(db(), q);
});

/**
 * Suggested tags for one tag-filter picker (`include` or `exclude`) — the list
 * it shows before the user types, and the popularity signal it re-ranks typed
 * results by. Drawn from logged searches: the tags most searched in that mode
 * across all users, with the signed-in user's own recently-used tags floated to
 * the front (see {@link getTagSuggestionsFromDb}). Empty when no history matches
 * (e.g. a fresh database), in which case the picker simply waits for a query.
 */
export const getTagSuggestions = query(
	v.picklist(['include', 'exclude']),
	async (mode): Promise<Tag[]> => {
		const user = requireUser();
		return getTagSuggestionsFromDb(db(), user.id, mode);
	}
);

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
	requireUser();
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
