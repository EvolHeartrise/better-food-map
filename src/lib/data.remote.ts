import { query } from '$app/server';
import { type Item, type MapData, type MapStats } from '$lib/server/db';
import { MapCellsQuerySchema, runMapCellsQuery } from '$lib/server/map-cells-query';
import { getLocationDataSchema, getLocationDataById } from '$lib/server/location-data';
import { getCachedStats } from '$lib/server/stats';
import { resolveUserLocation } from '$lib/server/user-location';

/**
 * Returns everything the map page needs for a batch of grid cells (see
 * MapCellsData): each requested cell's locations with their per-item overrides,
 * plus each shared brand menu those locations reference, resolved once and keyed
 * by menu_id — the same lean wire shape the old whole-viewport read used (#83),
 * plus the per-cell membership record the client store slices by. Panning fetches
 * only newly uncovered cells (#84), and the server answers repeat cells from a
 * colo-shared cache instead of re-running the D1 read per visitor (#93) — see
 * $lib/server/cell-cache.
 *
 * Schema and handler both live in $lib/server/map-cells-query, shared verbatim
 * with the GET /api/v1/map-cells endpoint (the mobile bridge) — see that module
 * for the validation rationale and the search-gating behaviour.
 *
 * Public: the map is open to everyone (no sign-in gate), so this read carries no
 * `requireUser()`. Only the user-scoped functions (likes, saved diet) require auth.
 */
export const getMapCells = query(MapCellsQuerySchema, runMapCellsQuery);

/**
 * Returns a single location (by id) in the same {@link MapData} shape as
 * {@link getMapCells}, but with FULL items — description and price — and its
 * menu's sources on `menuMeta` (provenance is menu-level). The detail panel always
 * resolves the open venue through this read (deduped by id on the client), which
 * is what lets the bulk viewport/search payloads stay lean (#83). Yields an empty
 * payload if no open location has that id.
 *
 * Schema and handler live in $lib/server/location-data, shared with the
 * GET /api/v1/locations/[id] endpoint.
 */
export const getLocationData = query(
	getLocationDataSchema,
	(id): Promise<MapData<Item>> => getLocationDataById(id)
);

/**
 * Aggregate coverage totals (locations, items, cities) for the zoomed-out landing
 * overlay. Public — no sign-in required, and it returns only counts, never any row
 * data. The 5-minute memo lives in $lib/server/stats (getCachedStats), shared with
 * the GET /api/v1/stats endpoint so both hit ONE warmed cache.
 */
export const getStats = query((): Promise<MapStats> => getCachedStats());

/**
 * Best-effort opening location for the map, from Cloudflare's edge IP geolocation
 * (`request.cf`). Prompt-free — unlike the browser Geolocation API it needs no
 * user permission — at the cost of being only city-level accurate. Only the Worker
 * can see `request.cf`, which is why this is a remote function. Returns `null` when
 * coordinates are unavailable (notably under local `vite dev`). The read + guards
 * live in $lib/server/user-location (resolveUserLocation), shared with the
 * GET /api/v1/user-location endpoint.
 */
export const getUserLocation = query(
	async (): Promise<{ lat: number; lng: number } | null> => resolveUserLocation()
);
