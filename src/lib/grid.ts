// The ONE map-data grid shared by the client and the server: the absolute
// lat/lng lattice the viewport reads are keyed on. The client (+page.svelte)
// picks a LEVEL for its viewport, enumerates the level's cells covering it and
// fetches only the cells it hasn't cached; the server ($lib/server/db
// getMapCellsData) answers per cell — so both sides must agree, exactly, on
// what a level is and which cell a coordinate falls in. Client-safe: no
// server-only imports (like $lib/bounds, which it builds on).
//
// A cell's contents are a pure function of the DATA, never of the viewport:
// cells sit on an absolute lattice (anchored at lat −90 / lng −180), sizes come
// from a discrete ladder, and the per-cell representative ranking is computed
// within the cell alone. That is what makes a cell cacheable — client-side
// across pans, server-side across users (#84, #93).

import type { Bounds } from './bounds';

/**
 * The 1–2–5×10ⁿ ladder of cell sizes (degrees), as LITERALS. Decimal literals
 * parse to the same IEEE double in every JS engine (and bind to the same REAL
 * in SQLite), unlike a `m * 10 ** n` chain, whose `Math.pow` rounding is not
 * spec-pinned — so a ladder built from literals is the only way the client's
 * cell arithmetic is guaranteed float-identical to the server's.
 */
export const CELL_LADDER = [
	0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
	100, 200, 500, 1000
] as const;

// Target number of grid cells across the viewport's longer span; the
// representative cap (GRID_REP_LIMIT) bounds the total, this sets how fine the
// lattice is.
const GRID_DIVISIONS = 12;

/**
 * Below this cell size (~440 m) the viewport is a neighbourhood: downsampling
 * would start hiding genuinely distinct on-screen venues, so such views use the
 * FULL level (level 0) — every venue per cell — instead of a representative rung.
 */
export const MIN_GRID_CELL_DEG = 0.004;

/**
 * Hard ceiling on how many representative cells a single viewport can touch.
 * {@link levelForBounds} coarsens the rung until a box of the viewport's span
 * cannot straddle more than this many absolute cells, so a rep-level fetch is
 * never a top-N cut over the in-view cells (a cut reshuffles as the box slides,
 * flickering labels in and out — see the pan-stability note below). This bounds
 * the CELL count; each cell resolves up to REP_CELL_CAP venues ($lib/server/db),
 * so a rep batch ships up to that many times this — still order-stable per cell,
 * which is what pan-stability needs. Numerically equal to the server's
 * MAP_RESULT_LIMIT (asserted in grid.test.ts; this module is client-safe, so it
 * cannot import the server constant).
 */
export const GRID_REP_LIMIT = 200;

/**
 * The fixed cell size (degrees, ~2.2 km of latitude) of the FULL level — the
 * tiles a narrow (neighbourhood) viewport is served from, each carrying every
 * open venue inside it (importance-ranked, capped per cell server-side). One
 * fixed rung, rather than one per zoom, so a session's fine-zoom panning
 * accumulates one shared tile set.
 */
export const FULL_CELL_DEG = 0.02;

/**
 * Grid levels: level 0 is the FULL level ({@link FULL_CELL_DEG}, every venue in
 * the cell); level k ≥ 1 is the REPRESENTATIVE rung of {@link CELL_LADDER}[k−1]
 * (the top few importance-ranked venues per cell — REP_CELL_CAP in
 * $lib/server/db). {@link MIN_REP_LEVEL} is the finest
 * rep level {@link levelForBounds} can produce (the first rung at or above
 * {@link MIN_GRID_CELL_DEG}) — the remote schema rejects levels 1..MIN_REP_LEVEL−1,
 * which no real client ever asks for.
 */
export const MIN_REP_LEVEL = CELL_LADDER.indexOf(0.005) + 1;
export const MAX_GRID_LEVEL = CELL_LADDER.length;

/**
 * How many cells one getMapCells request may carry. Rep levels are bounded by
 * the coarsening invariant ({@link GRID_REP_LIMIT}); the full level by the
 * narrow-viewport geometry — a padded narrow box spans < 0.05°, touching ≤ 16
 * FULL_CELL_DEG cells, so 24 covers every real client with slack while denying
 * a forged request the old 64-cell allowance (64 × the 100/cell cap = a 6,400-
 * venue resolve; 24 keeps the forgeable worst within ~1.5× the legitimate one).
 * The bound is enforced on the INPUT only — never as an output trim, which
 * would make a cell's contents depend on its batch-mates and break the purity
 * both cache layers are built on.
 */
export const REP_LEVEL_MAX_CELLS = GRID_REP_LIMIT;
export const FULL_LEVEL_MAX_CELLS = 24;

/** The cell size (degrees) of a grid level. */
export function levelCell(level: number): number {
	return level === 0 ? FULL_CELL_DEG : CELL_LADDER[level - 1];
}

/**
 * Snaps a raw degree span onto {@link CELL_LADDER}, returning the ladder index —
 * boundaries at the arithmetic midpoint of neighbouring rungs (1.5, 3.5, 7.5
 * ×10ⁿ), so a small zoom change steps the lattice discretely rather than
 * continuously resizing it (and reshuffling representatives). Values beyond
 * either end clamp to the end rung.
 */
export function ladderIndexFor(raw: number): number {
	for (let k = 0; k < CELL_LADDER.length - 1; k++) {
		if (raw < (CELL_LADDER[k] + CELL_LADDER[k + 1]) / 2) return k;
	}
	return CELL_LADDER.length - 1;
}

/**
 * The grid level for a viewport (the PADDED box <LocationMap> reports). Level 0
 * (full tiles) when the box is a neighbourhood — its base rung would fall below
 * {@link MIN_GRID_CELL_DEG} — else the base rung coarsened up the ladder until
 * the box's WORST-CASE cell count fits under {@link GRID_REP_LIMIT}.
 *
 * The bound `(⌈latSpan/cell⌉+1)·(⌈lngSpan/cell⌉+1)` is the most absolute-lattice
 * cells a box of this span can straddle — the +1 per axis is the box-vs-lattice
 * misalignment, and it must be there (omitting it under-counts and a top-N trim
 * starts to bite). Because the bound depends only on the span, not the pan
 * position, the chosen level is itself pan-stable: panning at one zoom never
 * changes the level, so it never reshuffles which venue represents a cell.
 */
export function levelForBounds(bounds: Bounds): number {
	const latSpan = bounds.maxLat - bounds.minLat;
	const lngSpan = bounds.maxLng - bounds.minLng;
	const span = Math.max(latSpan, lngSpan);
	if (!(span > 0)) return 0;
	let idx = ladderIndexFor(span / GRID_DIVISIONS);
	// Decide full-vs-rep on the BASE rung, so the boundary is the documented
	// ~440 m cell; coarsening below only ever grows the cell.
	if (CELL_LADDER[idx] < MIN_GRID_CELL_DEG) return 0;
	while (
		idx + 1 < CELL_LADDER.length &&
		(Math.ceil(latSpan / CELL_LADDER[idx]) + 1) * (Math.ceil(lngSpan / CELL_LADDER[idx]) + 1) >
			GRID_REP_LIMIT
	) {
		idx++;
	}
	return idx + 1;
}

/**
 * The canonical string key of a cell — what the client store, the server cache
 * and the SQL partition all agree on. The SQL builds the identical string with
 * `CAST(… AS INTEGER) || ':' || CAST(… AS INTEGER)` (see getMapCellsData).
 */
export function cellKey(i: number, j: number): string {
	return `${i}:${j}`;
}

/**
 * Every cell of size `cell` that a viewport touches, as [i, j] lattice indices
 * (i from latitude, j from longitude; both shifted non-negative — +90/+180 — so
 * `Math.floor` here and SQLite's truncating CAST agree everywhere). Clamped to
 * the data domain — venues only exist in lat [−90, 90] × lng [−180, 180], and a
 * zoomed-out globe reports unwrapped longitudes far beyond it — so a view of
 * pure out-of-domain space yields no cells (matching the old box read, which
 * matched no rows there). Sorted (i, then j): a canonical order means an
 * identical cell set always serializes to an identical request payload.
 */
export function cellsForBounds(bounds: Bounds, cell: number): [number, number][] {
	const minLat = Math.max(bounds.minLat, -90);
	const maxLat = Math.min(bounds.maxLat, 90);
	const minLng = Math.max(bounds.minLng, -180);
	const maxLng = Math.min(bounds.maxLng, 180);
	if (minLat > maxLat || minLng > maxLng) return [];
	const i0 = Math.floor((minLat + 90) / cell);
	const i1 = Math.floor((maxLat + 90) / cell);
	const j0 = Math.floor((minLng + 180) / cell);
	const j1 = Math.floor((maxLng + 180) / cell);
	const cells: [number, number][] = [];
	for (let i = i0; i <= i1; i++) {
		for (let j = j0; j <= j1; j++) cells.push([i, j]);
	}
	return cells;
}

/**
 * The geographic bounding box covering a set of cells — the INDEXED pre-filter
 * the server query narrows by before the exact per-row cell-key test (which is
 * authoritative). Padded by a hair so a venue whose float cell-index computation
 * lands exactly on a lattice line can never fall in the sliver between the
 * cover and its cell; the pad only ever admits extra rows for the exact test to
 * discard.
 */
export function cellsCoverBounds(cells: [number, number][], cell: number): Bounds {
	let minI = Infinity;
	let maxI = -Infinity;
	let minJ = Infinity;
	let maxJ = -Infinity;
	for (const [i, j] of cells) {
		if (i < minI) minI = i;
		if (i > maxI) maxI = i;
		if (j < minJ) minJ = j;
		if (j > maxJ) maxJ = j;
	}
	const EPS = 1e-9;
	return {
		minLat: minI * cell - 90 - EPS,
		maxLat: (maxI + 1) * cell - 90 + EPS,
		minLng: minJ * cell - 180 - EPS,
		maxLng: (maxJ + 1) * cell - 180 + EPS
	};
}

// --- Cache blocks ------------------------------------------------------------
// The server's colo cache does NOT store one entry per cell: the Workers Cache
// API costs one subrequest per match/put against a hard per-request budget (50
// on the Free plan, shared with D1 calls), and a world-zoom viewport touches
// ~190 cells — per-cell entries would blow the budget on the very landing fetch
// the cache exists to serve. Entries are instead keyed on aligned BLOCKS of
// cells; a viewport's worst case is a handful of blocks (asserted in
// grid.test.ts), keeping cache traffic O(10) per request at every zoom. The
// block math lives here — pure and client-safe — so it can be unit-tested; only
// $lib/server/cell-cache consumes it.

/**
 * Cells per block side. Representative cells are tiny (one venue each), so 8×8
 * blocks stay small; full-level cells carry whole neighbourhoods, so 4×4 bounds
 * the venues a single block miss must compute (≤ 16 × FULL_CELL_CAP).
 */
export function blockSpan(level: number): number {
	return level === 0 ? 4 : 8;
}

/**
 * The most blocks one request is served through the server cache for. Real
 * viewports top out around a dozen blocks — grid.test.ts sweeps the viewport
 * space to hold that — so a request scattering its cells more widely is forged,
 * and the cache layer bypasses it straight to the D1 read. Worst-case cache
 * traffic is ≤ 2× this (matches + puts), comfortably inside the Workers Free
 * plan's 50-subrequest budget alongside the request's D1 calls.
 */
export const MAX_CACHED_BLOCKS = 16;

/** The block a cell belongs to, as [bi, bj] block-lattice indices. */
export function blockOf(i: number, j: number, span: number): [number, number] {
	return [Math.floor(i / span), Math.floor(j / span)];
}

/**
 * Every domain-valid cell of a block, in the same [i, j] form the cell reads
 * use. A block straddling the domain edge (the pole rows, the antimeridian
 * columns) yields only its in-domain cells, mirroring cellsForBounds' clamp —
 * so a cached block always answers exactly the cells a client can legally ask
 * for, and nothing else.
 */
export function blockCells(bi: number, bj: number, span: number, cell: number): [number, number][] {
	const maxI = Math.floor(180 / cell);
	const maxJ = Math.floor(360 / cell);
	const cells: [number, number][] = [];
	for (let i = bi * span; i < (bi + 1) * span; i++) {
		if (i < 0 || i > maxI) continue;
		for (let j = bj * span; j < (bj + 1) * span; j++) {
			if (j < 0 || j > maxJ) continue;
			cells.push([i, j]);
		}
	}
	return cells;
}
