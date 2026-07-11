/// <reference types="bun-types" />
// Exercises the venue sheet's dismiss rule ($lib/bottom-sheet): a firm downward
// flick dismisses regardless of distance, a firm upward flick always springs
// back, and a slow release closes only below half the screen.

import { test, expect } from 'bun:test';
import { SHEET_FLING_VELOCITY, shouldDismissSheet } from '../src/lib/bottom-sheet';

const VH = 800; // a typical phone height

test('a firm downward flick dismisses from any height', () => {
	expect(shouldDismissSheet(VH - 10, -SHEET_FLING_VELOCITY, VH)).toBe(true);
	expect(shouldDismissSheet(VH / 2, -1.2, VH)).toBe(true);
	expect(shouldDismissSheet(100, -2, VH)).toBe(true);
});

test('a firm upward flick springs back even when dragged far down', () => {
	expect(shouldDismissSheet(100, SHEET_FLING_VELOCITY, VH)).toBe(false);
	expect(shouldDismissSheet(VH / 4, 1.5, VH)).toBe(false);
});

test('a slow release dismisses below half the screen and springs back above it', () => {
	expect(shouldDismissSheet(VH / 2 - 1, 0, VH)).toBe(true);
	expect(shouldDismissSheet(VH / 2 + 1, 0, VH)).toBe(false);
	expect(shouldDismissSheet(VH - 5, 0, VH)).toBe(false);
	// Sub-fling drift doesn't change the height-based outcome.
	expect(shouldDismissSheet(VH / 2 + 1, -(SHEET_FLING_VELOCITY - 0.01), VH)).toBe(false);
	expect(shouldDismissSheet(VH / 2 - 1, SHEET_FLING_VELOCITY - 0.01, VH)).toBe(true);
});
