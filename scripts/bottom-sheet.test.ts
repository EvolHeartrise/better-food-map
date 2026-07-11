/// <reference types="bun-types" />
// Exercises the venue sheet's dismiss rule ($lib/bottom-sheet): a firm downward
// flick dismisses regardless of distance, a firm upward flick always springs
// back, and a slow release closes only past the halfway point.

import { test, expect } from 'bun:test';
import { SHEET_FLING_VELOCITY, shouldDismissSheet } from '../src/lib/bottom-sheet';

const PANEL_H = 800; // a typical phone-height panel

test('a firm downward flick dismisses from any offset', () => {
	expect(shouldDismissSheet(10, SHEET_FLING_VELOCITY, PANEL_H)).toBe(true);
	expect(shouldDismissSheet(PANEL_H / 2, 1.2, PANEL_H)).toBe(true);
	expect(shouldDismissSheet(700, 2, PANEL_H)).toBe(true);
});

test('a firm upward flick springs back even when dragged far down', () => {
	expect(shouldDismissSheet(700, -SHEET_FLING_VELOCITY, PANEL_H)).toBe(false);
	expect(shouldDismissSheet((PANEL_H * 3) / 4, -1.5, PANEL_H)).toBe(false);
});

test('a slow release dismisses past halfway and springs back before it', () => {
	expect(shouldDismissSheet(PANEL_H / 2 + 1, 0, PANEL_H)).toBe(true);
	expect(shouldDismissSheet(PANEL_H / 2 - 1, 0, PANEL_H)).toBe(false);
	expect(shouldDismissSheet(5, 0, PANEL_H)).toBe(false);
	// Sub-fling drift doesn't change the offset-based outcome.
	expect(shouldDismissSheet(PANEL_H / 2 - 1, SHEET_FLING_VELOCITY - 0.01, PANEL_H)).toBe(false);
	expect(shouldDismissSheet(PANEL_H / 2 + 1, -(SHEET_FLING_VELOCITY - 0.01), PANEL_H)).toBe(true);
});
