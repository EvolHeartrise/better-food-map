/// <reference types="bun-types" />
// Exercises the shared viewport grid ($lib/grid): level selection (full vs
// representative, ladder snapping, coarsening under the cell cap), cell
// enumeration/clamping, and the cover box. These are the invariants the whole
// cell-cache design leans on — a cell's identity must be a pure function of the
// data domain, and a viewport's cell count must stay under the request caps.

import { test, expect } from 'bun:test';
import {
	CELL_LADDER,
	FULL_CELL_DEG,
	FULL_LEVEL_MAX_CELLS,
	GRID_REP_LIMIT,
	MAX_CACHED_BLOCKS,
	MAX_GRID_LEVEL,
	MIN_GRID_CELL_DEG,
	MIN_REP_LEVEL,
	REP_LEVEL_MAX_CELLS,
	blockCells,
	blockOf,
	blockSpan,
	cellKey,
	cellsCoverBounds,
	cellsForBounds,
	ladderIndexFor,
	levelCell,
	levelForBounds
} from '../src/lib/grid';
import { MAP_RESULT_LIMIT } from '../src/lib/server/db';

// The rep-level cap and the server's result cap are the same bound expressed in
// two modules (grid.ts is client-safe and cannot import db.ts); hold them equal.
test('GRID_REP_LIMIT mirrors MAP_RESULT_LIMIT', () => {
	expect(GRID_REP_LIMIT).toBe(MAP_RESULT_LIMIT);
});

test('ladderIndexFor snaps at the 1.5/3.5/7.5 midpoints (the old niceStep boundaries)', () => {
	expect(CELL_LADDER[ladderIndexFor(1.4)]).toBe(1);
	expect(CELL_LADDER[ladderIndexFor(1.6)]).toBe(2);
	expect(CELL_LADDER[ladderIndexFor(3.4)]).toBe(2);
	expect(CELL_LADDER[ladderIndexFor(3.6)]).toBe(5);
	expect(CELL_LADDER[ladderIndexFor(7.4)]).toBe(5);
	expect(CELL_LADDER[ladderIndexFor(7.6)]).toBe(10);
	// Beyond either end clamps to the end rung rather than extrapolating.
	expect(CELL_LADDER[ladderIndexFor(1e-9)]).toBe(CELL_LADDER[0]);
	expect(CELL_LADDER[ladderIndexFor(1e9)]).toBe(CELL_LADDER[CELL_LADDER.length - 1]);
});

test('levelForBounds: a neighbourhood box gets the FULL level, a city box a rep rung', () => {
	// Span 0.02° (~2 km): base rung would be far below the ~440 m floor → level 0.
	const neighbourhood = { minLat: 49.2, maxLat: 49.22, minLng: -123.12, maxLng: -123.1 };
	expect(levelForBounds(neighbourhood)).toBe(0);
	expect(levelCell(0)).toBe(FULL_CELL_DEG);

	// Span 1°: base rung niceStep(1/12) = 0.1 → a representative level.
	const city = { minLat: 49, maxLat: 50, minLng: -124, maxLng: -123 };
	const level = levelForBounds(city);
	expect(level).toBeGreaterThanOrEqual(MIN_REP_LEVEL);
	expect(levelCell(level)).toBe(0.1);

	// A degenerate (zero-span) box is treated as narrow.
	expect(levelForBounds({ minLat: 49, maxLat: 49, minLng: -123, maxLng: -123 })).toBe(0);
});

test('levelForBounds coarsens so a viewport can never touch more than GRID_REP_LIMIT cells', () => {
	// 30°×30°: the base rung (2°) could straddle up to 16×16 = 256 cells > 200,
	// so the level must coarsen one rung to 5°.
	const dense = { minLat: 0, maxLat: 30, minLng: 0, maxLng: 30 };
	expect(levelCell(levelForBounds(dense))).toBe(5);

	// Sweep a range of spans/positions (including a padded world view with
	// unwrapped longitudes) and hold the enumeration invariant everywhere.
	const spans = [0.05, 0.3, 1, 7, 30, 61, 179, 360, 1000];
	for (const span of spans) {
		for (const offset of [0, 0.37, 11.11]) {
			const bounds = {
				minLat: Math.max(-90, -10 + offset),
				maxLat: Math.min(90, -10 + offset + Math.min(span, 179)),
				minLng: -200 + offset,
				maxLng: -200 + offset + span
			};
			const level = levelForBounds(bounds);
			expect(level).toBeLessThanOrEqual(MAX_GRID_LEVEL);
			const cells = cellsForBounds(bounds, levelCell(level));
			if (level > 0) {
				expect(level).toBeGreaterThanOrEqual(MIN_REP_LEVEL);
				expect(cells.length).toBeLessThanOrEqual(REP_LEVEL_MAX_CELLS);
			} else {
				expect(cells.length).toBeLessThanOrEqual(FULL_LEVEL_MAX_CELLS);
			}
		}
	}
});

test('every rep rung levelForBounds can pick sits at or above the ~440 m floor', () => {
	for (let exp = -3; exp <= 3; exp += 0.05) {
		const span = 10 ** exp;
		const level = levelForBounds({ minLat: 0, maxLat: span, minLng: 0, maxLng: span });
		if (level > 0) expect(levelCell(level)).toBeGreaterThanOrEqual(MIN_GRID_CELL_DEG);
	}
});

test('cellsForBounds enumerates the covering lattice cells, clamped to the data domain', () => {
	// A 2×2 block of 0.1° cells.
	const cells = cellsForBounds({ minLat: 0.05, maxLat: 0.15, minLng: 0.05, maxLng: 0.15 }, 0.1);
	expect(cells).toEqual([
		[900, 1800],
		[900, 1801],
		[901, 1800],
		[901, 1801]
	]);

	// The world-zoom landing case (#93): a full-world view at the 20° rung is
	// 10×19 = 190 cells after clamping unwrapped longitudes to [-180, 180] —
	// crucially at or under the request cap, so every visitor's landing fetch is
	// one valid batch of the SAME 190 cells.
	const world = cellsForBounds({ minLat: -90, maxLat: 90, minLng: -260, maxLng: 260 }, 20);
	expect(world.length).toBe(190);
	expect(world.length).toBeLessThanOrEqual(REP_LEVEL_MAX_CELLS);
	for (const [i, j] of world) {
		expect(i).toBeGreaterThanOrEqual(0);
		expect(j).toBeGreaterThanOrEqual(0);
	}

	// A box entirely outside the data domain yields nothing.
	expect(cellsForBounds({ minLat: 10, maxLat: 20, minLng: 200, maxLng: 260 }, 20)).toEqual([]);
});

test('cellsCoverBounds contains every coordinate that lands in the covered cells', () => {
	const cell = 0.05;
	const cells: [number, number][] = [
		[2784, 1137],
		[2784, 1138],
		[2785, 1137]
	];
	const cover = cellsCoverBounds(cells, cell);
	// Sample points across the cells: each point whose floor-index is one of the
	// requested cells must fall inside the cover box.
	for (const [i, j] of cells) {
		for (const f of [0, 0.001, 0.5, 0.999]) {
			const lat = (i + f) * cell - 90;
			const lng = (j + f) * cell - 180;
			expect(Math.floor((lat + 90) / cell)).toBe(i);
			expect(lat).toBeGreaterThanOrEqual(cover.minLat);
			expect(lat).toBeLessThanOrEqual(cover.maxLat);
			expect(lng).toBeGreaterThanOrEqual(cover.minLng);
			expect(lng).toBeLessThanOrEqual(cover.maxLng);
		}
	}
});

test('cellKey formats as the SQL-mirrored i:j string', () => {
	expect(cellKey(2784, 1137)).toBe('2784:1137');
});

// --- Cache blocks -----------------------------------------------------------
// The server cache stores cells in aligned blocks so per-request Cache API
// traffic stays O(10) at every zoom (the Workers Free plan allows only 50
// subrequests per request, shared with D1). These hold the block math and the
// budget invariant the cache layer's bypass threshold leans on.

test('blockCells enumerates exactly the domain-valid cells of a block', () => {
	// An interior 8×8 block at the 20° rung... except the domain only has 10
	// rows (i 0..9) and 19 columns (j 0..18), so edge blocks clamp.
	expect(blockCells(0, 0, 8, 20).length).toBe(64);
	// Block row 1 holds only i 8..9 of the 10-row domain; column block 2 only
	// j 16..18 of the 19-column domain.
	expect(blockCells(1, 0, 8, 20).length).toBe(2 * 8);
	expect(blockCells(1, 2, 8, 20).length).toBe(2 * 3);
	// Fully out-of-domain blocks are empty.
	expect(blockCells(5, 0, 8, 20)).toEqual([]);
	// Every cell of a block maps back to that block.
	for (const [i, j] of blockCells(3, 7, 8, 0.1)) {
		expect(blockOf(i, j, 8)).toEqual([3, 7]);
	}
});

test('every real viewport touches at most MAX_CACHED_BLOCKS blocks', () => {
	// Sweep spans from block zoom to (padded, unwrapped) world views across many
	// pan positions: the number of DISTINCT blocks the enumerated cells group
	// into must stay within the cache layer's budget at every level, else the
	// bypass threshold would kick real traffic off the cache.
	const spans = [0.01, 0.03, 0.05, 0.11, 0.3, 0.7, 1, 3, 7, 13, 30, 61, 100, 179, 360, 520, 1000];
	for (const span of spans) {
		for (const offset of [0, 0.137, 3.7, 41.3]) {
			const bounds = {
				minLat: Math.max(-90, -25 + offset),
				maxLat: Math.min(90, -25 + offset + Math.min(span, 180)),
				minLng: -170 + offset,
				maxLng: -170 + offset + span
			};
			const level = levelForBounds(bounds);
			const cells = cellsForBounds(bounds, levelCell(level));
			const span_ = blockSpan(level);
			const blocks = new Set(cells.map(([i, j]) => blockOf(i, j, span_).join(':')));
			expect(blocks.size).toBeLessThanOrEqual(MAX_CACHED_BLOCKS);
		}
	}
});
