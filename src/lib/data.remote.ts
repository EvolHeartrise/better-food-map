import * as v from 'valibot';
import { query, getRequestEvent } from '$app/server';
import { requireDb as db } from '$lib/server/context';
import { ttlMemo } from '$lib/server/memo';
import { getMapCellsCached } from '$lib/server/cell-cache';
import {
	getLocationMapData,
	getStats as getStatsFromDb,
	type Item,
	type MapCellsData,
	type MapData,
	type MapStats
} from '$lib/server/db';
import { searchableQuery } from '$lib/search';
import {
	FULL_LEVEL_MAX_CELLS,
	MAX_GRID_LEVEL,
	MIN_REP_LEVEL,
	REP_LEVEL_MAX_CELLS,
	levelCell
} from '$lib/grid';

/**
 * A batch of same-level grid cells the map page asks for (see $lib/grid for the
 * level/cell model; the page enumerates the cells covering its viewport and
 * sends only the ones its client store is missing), with the ACTIVE SEARCH
 * riding along: `q` is the combined free-text term and `diet` the dietary-tag
 * selector, both narrowing what each cell returns (see SearchFilter in
 * $lib/server/db) — so searching stays cell-based and panning under a search
 * fetches matches for the newly visible cells. Validated because this is
 * an open HTTP endpoint: `level` must be a level a real client can produce
 * (level 0, or a representative rung at/above the ~440 m floor — anything else
 * would spray the server cache with junk keys), the cell count is capped per
 * level (rep batches are bounded by the coarsening invariant; full-detail
 * batches by narrow-viewport geometry, so a forged request can't fan a
 * full-menu read across hundreds of cells), each index must lie inside the
 * lat/lng data domain, and the filter lengths bound what reaches the FTS index
 * (200 far exceeds any real search term; diet tag ids are short fixed tokens).
 */
const CellIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const MapCellsQuerySchema = v.pipe(
	v.object({
		level: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_GRID_LEVEL)),
		cells: v.pipe(
			v.array(v.tuple([CellIndexSchema, CellIndexSchema])),
			v.minLength(1),
			v.maxLength(REP_LEVEL_MAX_CELLS)
		),
		q: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
		diet: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64))), null)
	}),
	v.check((q) => q.level === 0 || q.level >= MIN_REP_LEVEL, 'Unknown grid level'),
	v.check(
		(q) => q.level !== 0 || q.cells.length <= FULL_LEVEL_MAX_CELLS,
		'Too many full-detail cells'
	),
	v.check((q) => {
		const cell = levelCell(q.level);
		const maxI = Math.floor(180 / cell);
		const maxJ = Math.floor(360 / cell);
		return q.cells.every(([i, j]) => i <= maxI && j <= maxJ);
	}, 'Cell outside the coordinate domain')
);

/**
 * Returns everything the map page needs for a batch of grid cells (see
 * {@link MapCellsData}): each requested cell's locations with their per-item
 * overrides, plus each shared brand menu those locations reference, resolved
 * once and keyed by menu_id — the same lean wire shape the old whole-viewport
 * read used (#83), plus the per-cell membership record the client store slices
 * by. Panning fetches only newly uncovered cells (#84), and the
 * server answers repeat cells from a colo-shared cache instead of re-running
 * the D1 read per visitor (#93) — see $lib/server/cell-cache.
 *
 * With `q`/`diet` set the same read returns only MATCHING venues per cell, so
 * an active search follows the viewport exactly like browse. The searchable
 * gate is applied HERE, before the cache layer, so the canonical filter keys
 * the colo cache: text the trigram index can't serve (no 3+ char wildcard-free
 * run — see $lib/search) is treated as absent rather than full-scanned; the
 * map page applies the same gate and never sends such text, so only a forged
 * request hits this floor, and it degrades to the diet-only filter or, with no
 * diet either, the plain browse read (#103/#104) — exactly what the client
 * itself renders for a short query.
 *
 * Public: the map is open to everyone (no sign-in gate), so this read carries no
 * `requireUser()`. Only the user-scoped functions (likes, saved diet) require auth.
 */
export const getMapCells = query(
	MapCellsQuerySchema,
	async ({ level, cells, q, diet }): Promise<MapCellsData> => {
		const text = searchableQuery(q);
		const search = text !== '' || diet !== null ? { query: text, dietTagId: diet } : null;
		return getMapCellsCached(level, cells, search);
	}
);

/**
 * Returns a single location (by id) in the same {@link MapData} shape as
 * {@link getMapCells}, but with FULL items — description, price, and item
 * sources merged with menu-level sources. The detail panel always resolves the
 * open venue through this read (deduped by id on the client), which is what lets
 * the bulk viewport/search payloads stay lean (#83). Yields an empty payload if
 * no location has that id. Ids are UUIDs or short slugs; the length cap only
 * rejects hostile payloads.
 */
export const getLocationData = query(
	v.pipe(v.string(), v.maxLength(128)),
	async (id): Promise<MapData<Item>> => {
		return getLocationMapData(db(), id);
	}
);

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
