/// <reference types="bun-types" />
// Guards that the SHARED map-cells schema (src/lib/server/map-cells-query.ts),
// now used by BOTH the getMapCells remote function and the GET /api/v1/map-cells
// endpoint, accepts and rejects the same shapes the remote schema always did — so
// the mobile bridge can't widen what a forged request is allowed to do. Spot
// cases only; the full ranking/search behaviour is covered by map-cells.test.ts.

import { test, expect } from 'bun:test';
import * as v from 'valibot';
import { MapCellsQuerySchema } from '../src/lib/server/map-cells-schema';
import { MIN_REP_LEVEL, FULL_LEVEL_MAX_CELLS } from '../src/lib/grid';

const ok = (input: unknown) => v.safeParse(MapCellsQuerySchema, input).success;

test('accepts a minimal full-level browse request', () => {
	expect(ok({ level: 0, cells: [[0, 0]], q: '', diet: null })).toBe(true);
});

test('accepts a representative level at the floor', () => {
	expect(ok({ level: MIN_REP_LEVEL, cells: [[0, 0]] })).toBe(true);
});

test('rejects a level between 1 and the rep floor (Unknown grid level)', () => {
	// MIN_REP_LEVEL is >= 2, so level 1 is neither full (0) nor a valid rep rung.
	expect(ok({ level: 1, cells: [[0, 0]] })).toBe(false);
});

test('rejects an empty cell batch and a non-integer index', () => {
	expect(ok({ level: 0, cells: [] })).toBe(false);
	expect(ok({ level: 0, cells: [[0.5, 0]] })).toBe(false);
	expect(ok({ level: 0, cells: [[-1, 0]] })).toBe(false);
});

test('rejects a full-level batch over the cell cap', () => {
	const tooMany = Array.from(
		{ length: FULL_LEVEL_MAX_CELLS + 1 },
		(_, i) => [0, i] as [number, number]
	);
	expect(ok({ level: 0, cells: tooMany })).toBe(false);
});

test('rejects a cell outside the coordinate domain', () => {
	// At level 0 (0.02°) the max i index is floor(180/0.02) = 9000.
	expect(ok({ level: 0, cells: [[99999, 0]] })).toBe(false);
});

test('rejects over-long free-text and diet filters', () => {
	expect(ok({ level: 0, cells: [[0, 0]], q: 'x'.repeat(201) })).toBe(false);
	expect(ok({ level: 0, cells: [[0, 0]], diet: 'y'.repeat(65) })).toBe(false);
});
