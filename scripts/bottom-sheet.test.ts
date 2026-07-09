/// <reference types="bun-types" />
// Exercises the venue bottom sheet's snap geometry ($lib/bottom-sheet): resting
// heights scale with the viewport and never collapse below the floor; a slow
// release settles to the nearest snap; a firm flick jumps a whole snap in its
// direction; and keyboard step / tap cycle walk the snap order.

import { test, expect } from 'bun:test';
import {
	SHEET_SNAPS,
	MIN_SHEET_PX,
	SHEET_FLING_VELOCITY,
	snapHeightPx,
	sheetBounds,
	nearestSnap,
	settleSnap,
	stepSnap,
	cycleSnap
} from '../src/lib/bottom-sheet';

const VH = 800; // a typical phone height
const peek = snapHeightPx('peek', VH); // 336
const half = snapHeightPx('half', VH); // 496
const full = snapHeightPx('full', VH); // 720

test('resting heights are ordered peek < half < full and scale with the viewport', () => {
	expect(peek).toBeLessThan(half);
	expect(half).toBeLessThan(full);
	expect(snapHeightPx('full', 1000)).toBeGreaterThan(snapHeightPx('full', 800));
});

test('a whole-pixel height is returned', () => {
	for (const snap of SHEET_SNAPS) {
		expect(Number.isInteger(snapHeightPx(snap, VH))).toBe(true);
	}
});

test('never collapses below the floor on a short screen (or with no viewport)', () => {
	expect(snapHeightPx('peek', 300)).toBe(MIN_SHEET_PX); // 0.42·300 = 126 → floored
	expect(snapHeightPx('full', 0)).toBe(MIN_SHEET_PX); // SSR / pre-measure
});

test('sheetBounds spans the shortest and tallest snaps', () => {
	expect(sheetBounds(VH)).toEqual({ min: peek, max: full });
});

test('nearestSnap picks the closest resting height', () => {
	expect(nearestSnap(peek, VH)).toBe('peek');
	expect(nearestSnap(half - 5, VH)).toBe('half');
	expect(nearestSnap(full + 200, VH)).toBe('full'); // beyond the top clamps to full
	// Just past the peek↔half midpoint lands on half.
	const mid = (peek + half) / 2;
	expect(nearestSnap(mid + 1, VH)).toBe('half');
	expect(nearestSnap(mid - 1, VH)).toBe('peek');
});

test('a slow release settles to the nearest snap regardless of drift direction', () => {
	expect(settleSnap(half - 10, 0, VH)).toBe('half');
	expect(settleSnap(half - 10, SHEET_FLING_VELOCITY - 0.01, VH)).toBe('half');
	expect(settleSnap(half - 10, -(SHEET_FLING_VELOCITY - 0.01), VH)).toBe('half');
});

test('a firm upward flick jumps to the next taller snap', () => {
	// Released near peek but flicked up hard → half, not peek.
	expect(settleSnap(peek + 10, SHEET_FLING_VELOCITY, VH)).toBe('half');
	// Flicked up from around half → full.
	expect(settleSnap(half, 1.2, VH)).toBe('full');
	// Already at the top: a firm up flick stays at full.
	expect(settleSnap(full, 2, VH)).toBe('full');
});

test('a firm downward flick jumps to the next shorter snap', () => {
	expect(settleSnap(half - 10, -SHEET_FLING_VELOCITY, VH)).toBe('peek');
	expect(settleSnap(full, -1.2, VH)).toBe('half');
	// Already at the bottom: a firm down flick stays at peek.
	expect(settleSnap(peek, -2, VH)).toBe('peek');
});

test('resting exactly on a snap is not nudged off it by a flick', () => {
	// Sitting on half with an up flick goes to full (strictly taller), not stuck.
	expect(settleSnap(half, SHEET_FLING_VELOCITY, VH)).toBe('full');
	// Sitting on half with a down flick goes to peek (strictly shorter).
	expect(settleSnap(half, -SHEET_FLING_VELOCITY, VH)).toBe('peek');
});

test('stepSnap moves one snap and clamps at the ends', () => {
	expect(stepSnap('peek', 1)).toBe('half');
	expect(stepSnap('half', 1)).toBe('full');
	expect(stepSnap('full', 1)).toBe('full'); // clamps
	expect(stepSnap('full', -1)).toBe('half');
	expect(stepSnap('peek', -1)).toBe('peek'); // clamps
});

test('cycleSnap wraps peek → half → full → peek', () => {
	expect(cycleSnap('peek')).toBe('half');
	expect(cycleSnap('half')).toBe('full');
	expect(cycleSnap('full')).toBe('peek');
});
