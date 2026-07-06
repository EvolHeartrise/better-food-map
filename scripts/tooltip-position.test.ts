/// <reference types="bun-types" />
// Exercises the shared tooltip's placement math ($lib/tooltip-position): the
// bubble prefers sitting above its anchor, flips below when it can't clear the
// top margin, clamps to the viewport horizontally, and keeps its arrow pointing
// at the anchor even when the bubble itself has been clamped.

import { test, expect } from 'bun:test';
import {
	placeTooltip,
	TOOLTIP_GAP,
	TOOLTIP_MARGIN,
	type AnchorRect
} from '../src/lib/tooltip-position';

const viewport = { width: 1000, height: 800 };
const tip = { width: 120, height: 28 };

function anchorAt(left: number, top: number, width = 20, height = 20): AnchorRect {
	return { left, top, width, height };
}

test('prefers sitting above the anchor, centred, with the arrow at the middle', () => {
	const anchor = anchorAt(490, 400);
	const placed = placeTooltip(anchor, tip, viewport);
	expect(placed.side).toBe('top');
	expect(placed.top).toBe(400 - TOOLTIP_GAP - tip.height);
	expect(placed.left).toBe(500 - tip.width / 2);
	expect(placed.arrowLeft).toBe(tip.width / 2);
});

test('flips below when the bubble would not clear the top margin', () => {
	const anchor = anchorAt(490, TOOLTIP_GAP + tip.height + TOOLTIP_MARGIN - 1);
	const placed = placeTooltip(anchor, tip, viewport);
	expect(placed.side).toBe('bottom');
	expect(placed.top).toBe(anchor.top + anchor.height + TOOLTIP_GAP);
});

test('stays above at exactly the top-margin boundary', () => {
	const anchor = anchorAt(490, TOOLTIP_GAP + tip.height + TOOLTIP_MARGIN);
	expect(placeTooltip(anchor, tip, viewport).side).toBe('top');
});

test('clamps to the left viewport edge, arrow still tracking the anchor', () => {
	const anchor = anchorAt(4, 400);
	const placed = placeTooltip(anchor, tip, viewport);
	expect(placed.left).toBe(TOOLTIP_MARGIN);
	// Anchor centre is at x=14; the arrow leans left of centre but never
	// closer than its inset to the bubble's corner.
	expect(placed.arrowLeft).toBe(10);
});

test('clamps to the right viewport edge', () => {
	const anchor = anchorAt(985, 400, 10, 10);
	const placed = placeTooltip(anchor, tip, viewport);
	expect(placed.left).toBe(viewport.width - TOOLTIP_MARGIN - tip.width);
	expect(placed.arrowLeft).toBe(tip.width - 10);
});

test('a bubble wider than the viewport pins to the left margin', () => {
	const wide = { width: 2000, height: 28 };
	const placed = placeTooltip(anchorAt(490, 400), wide, { width: 400, height: 800 });
	expect(placed.left).toBe(TOOLTIP_MARGIN);
});
