// The single-venue detail read, factored out of data.remote.ts so the
// `getLocationData` remote function AND the GET /api/v1/locations/[id] endpoint
// share ONE validation schema and ONE handler — the mobile bridge must not
// re-derive the id bound. Thin: the heavy lifting is getLocationMapData in db.ts.
import * as v from 'valibot';
import { requireDb } from './context';
import { getLocationMapData, type Item, type MapData } from './db';

/**
 * The id of the location to read. Ids are UUIDs or short slugs; the length cap
 * only rejects hostile payloads, never a real id.
 */
export const getLocationDataSchema = v.pipe(v.string(), v.maxLength(128));

/**
 * Returns a single location (by id) in the same {@link MapData} shape as the
 * map-cells read, but with FULL items — description and price — and its menu's
 * sources on `menuMeta` (provenance is menu-level). Yields an EMPTY payload
 * (`{ locations: [], menus: {}, menuMeta: {} }`) when no OPEN location has that id
 * — an unknown id and a soft-deleted (permanently-closed) venue are
 * indistinguishable here, since getLocationMapData filters `closed_at IS NULL`
 * (migration 0015); the caller treats an empty `locations` array as "not found".
 */
export function getLocationDataById(id: string): Promise<MapData<Item>> {
	return getLocationMapData(requireDb(), id);
}
