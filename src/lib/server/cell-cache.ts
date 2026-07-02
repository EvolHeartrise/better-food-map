// Read-through per-cell cache in front of getMapCellsData, on the Workers Cache
// API (`caches.default`). A cell's payload depends on the data alone (see
// $lib/grid), so every visitor looking at the same area shares one entry: after
// the first request per colo per TTL window, a world-zoom landing — previously a
// full-table window sort PER VISITOR (#93) — costs zero D1 reads.
//
// Why the Cache API and not a ttlMemo: the memo caches a PROMISE, and a cached
// request-scoped D1 promise whose request is torn down mid-read never settles —
// the exact footgun getStats/cachedSitemapEntries need waitUntil choreography
// for. The Cache API stores the serialized RESPONSE: a lost put is just a
// re-read, never a wedge, and entries are shared colo-wide across isolates
// rather than per-isolate. NOTE: this module reaches `$app/server`, so tests
// must not import it — they exercise getMapCellsData and the slice helpers.
import { version } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { requireDb } from './context';
import { getMapCellsData, type MapCellsData } from './db';
import { assembleCellsData, splitCellSlices, type CellSlice } from '$lib/map-cells';
import { cellKey } from '$lib/grid';

/**
 * How long a cached cell serves. Data changes only via MCP ingestion, so minutes
 * of staleness is invisible on the map; keeping it short means imports surface
 * without any purge machinery (no purge-capable token exists for this zone).
 */
export const CELL_CACHE_TTL_SECONDS = 300;

/**
 * Minimal structural view of a Workers Cache API cache — the same move as
 * db.ts's D1Like. The adapter types `platform.caches` with workers-types'
 * CacheStorage, whose `put` wants workers-types' `Response` — a class the
 * lib.dom `new Response(...)` this module constructs is NOT assignable to
 * (the two ambient Response declarations conflict). The one cast below views
 * the runtime cache through this narrow surface instead, which both type
 * worlds satisfy.
 */
export interface CellCacheLike {
	match(url: string): Promise<{ json(): Promise<unknown> } | undefined>;
	// Structural on purpose: naming `Response` here would resolve to
	// workers-types' class and re-import the clash. Any real Response satisfies.
	put(url: string, response: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<unknown>;
}

/**
 * The synthetic URL a cell is cached under. Same-origin so the key is
 * unambiguously valid for `cache.put`; no route serves this path, and the
 * entries never leave the Worker. The app VERSION is part of the key so a
 * deploy that changes the payload shape (or the grid) starts from a cold cache
 * instead of serving week-old slices to new code.
 */
function cellCacheUrl(origin: string, level: number, i: number, j: number): string {
	return `${origin}/__cell-cache/${encodeURIComponent(version)}/${level}/${i}/${j}`;
}

/**
 * {@link getMapCellsData} through the per-cell cache: cached cells are answered
 * from the colo, the rest resolve in ONE D1 read and are written back — empty
 * cells included, as negative entries. Falls back to the plain read when the
 * Cache API isn't available (vite dev without the adapter proxy, tests).
 */
export async function getMapCellsCached(
	level: number,
	cells: [number, number][]
): Promise<MapCellsData> {
	const event = getRequestEvent();
	const db = requireDb();
	const cache = event.platform?.caches?.default as CellCacheLike | undefined;
	if (!cache) return getMapCellsData(db, level, cells);

	const origin = event.url.origin;
	const slices = new Map<string, CellSlice>();
	const misses: [number, number][] = [];
	const matches = await Promise.all(
		cells.map(([i, j]) => cache.match(cellCacheUrl(origin, level, i, j)))
	);
	for (let k = 0; k < cells.length; k++) {
		const res = matches[k];
		if (res) {
			try {
				const slice = (await res.json()) as CellSlice;
				slices.set(cellKey(cells[k][0], cells[k][1]), slice);
				continue;
			} catch {
				// An unreadable entry (interrupted write, eviction race) is a miss.
			}
		}
		misses.push(cells[k]);
	}

	if (misses.length > 0) {
		const fresh = await getMapCellsData(db, level, misses);
		const freshSlices = splitCellSlices(fresh);
		const puts: Promise<unknown>[] = [];
		for (const [i, j] of misses) {
			const key = cellKey(i, j);
			// getMapCellsData returns every requested cell (empty ones as []), so the
			// fallback is unreachable belt-and-braces.
			const slice = freshSlices.get(key) ?? { locations: [], menus: {}, menuMeta: {} };
			slices.set(key, slice);
			puts.push(
				cache.put(
					cellCacheUrl(origin, level, i, j),
					new Response(JSON.stringify(slice), {
						headers: {
							'Content-Type': 'application/json',
							'Cache-Control': `public, max-age=${CELL_CACHE_TTL_SECONDS}`
						}
					})
				)
			);
		}
		// The puts are write-behind: the response doesn't wait on them, but the
		// request context must outlive them or the writes are torn down with it.
		// allSettled so one failed put can't reject the batch — a lost put only
		// means the next visitor re-reads. Built BEFORE the optional waitUntil
		// call: an optional call short-circuits its argument too, and the puts
		// must be wrapped even where no ctx exists (dev) or their rejections
		// surface as unhandled.
		const flush = Promise.allSettled(puts).then(() => undefined);
		event.platform?.ctx?.waitUntil(flush);
	}

	return assembleCellsData(slices);
}
