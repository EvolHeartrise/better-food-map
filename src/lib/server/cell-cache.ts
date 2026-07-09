// Read-through cache in front of getMapCellsData, on the Workers Cache API
// (`caches.default`). A cell's payload depends on the data alone (see
// $lib/grid), so every visitor looking at the same area shares the entries:
// after the first request per colo per TTL window, a world-zoom landing —
// previously a full-table window sort PER VISITOR (#93) — costs zero D1 reads.
//
// Entries are keyed on aligned BLOCKS of cells, not single cells: every Cache
// API match/put is a subrequest against a hard per-request budget (50 on the
// Workers Free plan, 1000 on Paid — developers.cloudflare.com/workers/platform/
// limits), and a world viewport touches ~190 cells, so per-cell entries would
// blow the Free budget on the exact landing fetch this cache exists to serve.
// A viewport's cells group into at most a dozen blocks (grid.test.ts asserts
// the invariant), keeping cache traffic O(10) per request; a block miss
// computes the WHOLE block in the one D1 read, so neighbouring viewports warm
// each other. Requests whose cells scatter across more blocks than a real
// viewport can touch (forgeable only) bypass the cache straight to the D1
// read, which is also the fallback if the cache layer itself fails — a cache
// error must never 500 a read the database can serve.
//
// Why the Cache API and not a ttlMemo: the memo caches a PROMISE, and a cached
// request-scoped D1 promise whose request is torn down mid-read never settles —
// the exact footgun getStats/cachedSitemapEntries need waitUntil choreography
// for. The Cache API stores the serialized RESPONSE: a lost put is just a
// re-read, never a wedge, and entries are shared colo-wide across isolates
// rather than per-isolate. NOTE: this module reaches `$app/server`, so tests
// must not import it — they exercise getMapCellsData, the slice helpers and
// the block math directly.
import { version } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { requireDb } from './context';
import { getMapCellsData, type MapCellsData, type SearchFilter } from './db';
import { assembleCellsData, splitCellSlices, type CellSlice } from '$lib/map-cells';
import { MAX_CACHED_BLOCKS, blockCells, blockOf, blockSpan, cellKey, levelCell } from '$lib/grid';

/**
 * How long a cached block serves. Data changes only via MCP ingestion, so
 * minutes of staleness is invisible on the map; keeping it short means imports
 * surface without any purge machinery (no purge-capable token exists for this
 * zone).
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

const EMPTY_SLICE: CellSlice = { locations: [], menus: {}, menuMeta: {} };

/**
 * The synthetic URL a block is cached under. A CONSTANT origin, deliberately
 * not the request's: `event.url` inside a remote function derives from
 * client-suppliable request data, and keying on it would let a forged origin
 * sidestep (and pollute) the shared namespace. The host resolves nowhere and
 * no route serves the path — the entries never leave the Worker. The app
 * VERSION is part of the key so a deploy that changes the payload shape (or
 * the grid) starts from a cold cache instead of serving week-old blocks to
 * new code.
 *
 * A search filter joins the key as query params (the caller passes the GATED
 * text, so "jo"+diet and ""+diet share one entry): a block's contents depend
 * on (level, block, filter). Diet-only filters have a 6-value cardinality and
 * cache as well as browse; free-text filters are long-tail — entries just age
 * out — but repeat searches of common terms in a metro still share. The
 * `diet` param is appended only when set, so a null diet can never collide
 * with an empty-string one.
 */
function blockCacheUrl(level: number, bi: number, bj: number, search: SearchFilter | null): string {
	const base = `https://cell-cache.internal/${encodeURIComponent(version)}/${level}/${bi}:${bj}`;
	if (search === null) return base;
	const diet = search.dietTagId === null ? '' : `&diet=${encodeURIComponent(search.dietTagId)}`;
	return `${base}?q=${encodeURIComponent(search.query)}${diet}`;
}

/**
 * {@link getMapCellsData} through the block cache: cached blocks answer from
 * the colo, the missing blocks are computed WHOLE in one D1 read and written
 * back — empty cells included, as negative entries — and the response carries
 * exactly the requested cells. Falls back to the plain uncached read when the
 * Cache API is unavailable (vite dev without the adapter proxy), when the
 * request's cells scatter past {@link MAX_CACHED_BLOCKS}, or when the cache
 * path throws.
 */
export async function getMapCellsCached(
	level: number,
	cells: [number, number][],
	search: SearchFilter | null = null
): Promise<MapCellsData> {
	const event = getRequestEvent();
	const db = requireDb();
	const cache = event.platform?.caches?.default as CellCacheLike | undefined;

	const span = blockSpan(level);
	const blocks = new Map<string, { bi: number; bj: number; cells: [number, number][] }>();
	for (const [i, j] of cells) {
		const [bi, bj] = blockOf(i, j, span);
		const key = `${bi}:${bj}`;
		const block = blocks.get(key) ?? { bi, bj, cells: [] };
		block.cells.push([i, j]);
		blocks.set(key, block);
	}
	if (!cache || blocks.size > MAX_CACHED_BLOCKS) return getMapCellsData(db, level, cells, search);

	try {
		const blockList = [...blocks.values()];
		const matches = await Promise.all(
			blockList.map((b) => cache.match(blockCacheUrl(level, b.bi, b.bj, search)))
		);

		const sliceByCell = new Map<string, CellSlice>();
		const missing: typeof blockList = [];
		for (let k = 0; k < blockList.length; k++) {
			const res = matches[k];
			if (res) {
				try {
					const blockData = (await res.json()) as MapCellsData;
					const blockSlices = splitCellSlices(blockData);
					// A block entry must answer every domain-valid cell it spans; one
					// missing from the record means a foreign/stale entry — recompute.
					const found = blockList[k].cells.map(([i, j]) => blockSlices.get(cellKey(i, j)));
					if (found.every((slice) => slice !== undefined)) {
						blockList[k].cells.forEach(([i, j], n) => sliceByCell.set(cellKey(i, j), found[n]));
						continue;
					}
				} catch {
					// An unreadable entry (interrupted write, eviction race) is a miss.
				}
			}
			missing.push(blockList[k]);
		}

		if (missing.length > 0) {
			// One D1 read for every cell of every missing block — whole blocks, not
			// just the requested cells, so the entry can answer any neighbouring
			// viewport that touches the block later.
			const cellDeg = levelCell(level);
			const expanded = missing.flatMap((b) => blockCells(b.bi, b.bj, span, cellDeg));
			const fresh = await getMapCellsData(db, level, expanded, search);
			const freshSlices = splitCellSlices(fresh);
			const puts: Promise<unknown>[] = [];
			for (const b of missing) {
				const blockMap = new Map<string, CellSlice>();
				for (const [i, j] of blockCells(b.bi, b.bj, span, cellDeg)) {
					const key = cellKey(i, j);
					blockMap.set(key, freshSlices.get(key) ?? EMPTY_SLICE);
				}
				puts.push(
					cache.put(
						blockCacheUrl(level, b.bi, b.bj, search),
						new Response(JSON.stringify(assembleCellsData(blockMap)), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': `public, max-age=${CELL_CACHE_TTL_SECONDS}`
							}
						})
					)
				);
				for (const [i, j] of b.cells) {
					const key = cellKey(i, j);
					sliceByCell.set(key, blockMap.get(key) ?? EMPTY_SLICE);
				}
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

		const requested = new Map<string, CellSlice>();
		for (const [i, j] of cells) {
			const key = cellKey(i, j);
			requested.set(key, sliceByCell.get(key) ?? EMPTY_SLICE);
		}
		return assembleCellsData(requested);
	} catch {
		// The cache layer must never fail a read the database can serve: any
		// error above (a Cache API limit, a runtime quirk) degrades to the
		// plain uncached read.
		return getMapCellsData(db, level, cells, search);
	}
}
