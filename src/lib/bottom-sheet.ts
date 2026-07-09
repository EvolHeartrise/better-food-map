// The narrow-screen venue bottom sheet's snap geometry — a pure module so
// scripts/bottom-sheet.test.ts can pin the drag/settle math without a DOM.
//
// On a phone the venue detail panel is a bottom sheet the user can drag,
// tap-to-cycle or key up/down between three resting heights ("snaps"):
//   peek — the compact height a venue opens at (header + info + a few rows),
//   half — a taller reading window,
//   full — a thin strip of map above an almost-full-height sheet, so a 50+ item
//          exhaustive menu can actually be read (issue #249).
// Each snap is a FRACTION of the viewport height so the sheet scales with the
// device; the page mirrors the resting height as the map's camera inset and as
// the `--sheet-height` custom property that lifts the OSM attribution clear of
// the sheet.

export type SheetSnap = 'peek' | 'half' | 'full';

// Ordered shortest → tallest. Drag settling, keyboard stepping and tap cycling
// all walk this order, so it is the single source of truth for "next"/"prev".
export const SHEET_SNAPS = ['peek', 'half', 'full'] as const satisfies readonly SheetSnap[];

// Each snap's height as a fraction of the viewport. 'full' deliberately stops
// short of the whole screen so the map strip (and its attribution) stays visible.
const SNAP_FRACTION: Record<SheetSnap, number> = {
	peek: 0.42,
	half: 0.62,
	full: 0.9
};

// Floor so the sheet never collapses below a usable height (header + grip +
// a couple of rows) on a very short landscape phone, where 0.42·vh would be tiny.
export const MIN_SHEET_PX = 200;

// The resting pixel height for a snap at the given viewport height. Rounded to a
// whole pixel (the value drives a CSS length and a camera inset). A zero/absent
// viewport (SSR, before the first measure) floors to MIN_SHEET_PX.
export function snapHeightPx(snap: SheetSnap, viewportHeight: number): number {
	const vh = viewportHeight > 0 ? viewportHeight : 0;
	return Math.max(MIN_SHEET_PX, Math.round(SNAP_FRACTION[snap] * vh));
}

// The drag's clamp range: the shortest and tallest snap heights. A live drag is
// pinned within these so the sheet can't be flung off either end.
export function sheetBounds(viewportHeight: number): { min: number; max: number } {
	return {
		min: snapHeightPx('peek', viewportHeight),
		max: snapHeightPx('full', viewportHeight)
	};
}

// The snap whose resting height is closest to `heightPx`. Ties resolve to the
// earlier (shorter) snap, since the scan keeps the first-seen minimum.
export function nearestSnap(heightPx: number, viewportHeight: number): SheetSnap {
	let best: SheetSnap = SHEET_SNAPS[0];
	let bestDistance = Infinity;
	for (const snap of SHEET_SNAPS) {
		const distance = Math.abs(snapHeightPx(snap, viewportHeight) - heightPx);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = snap;
		}
	}
	return best;
}

// A flick faster than this (px per millisecond of height change, + = growing)
// jumps a whole snap in its direction instead of settling to the nearest.
export const SHEET_FLING_VELOCITY = 0.5;

// Where a drag settles when the finger lifts. A firm upward flick lands on the
// next snap taller than the release height (or the tallest); a firm downward
// flick on the next shorter (or the shortest); a slow release settles to the
// nearest snap by height. The ±1px guards keep a release resting exactly on a
// snap from being nudged off it by rounding noise.
export function settleSnap(heightPx: number, velocity: number, viewportHeight: number): SheetSnap {
	const ascending = SHEET_SNAPS.map((snap) => ({ snap, h: snapHeightPx(snap, viewportHeight) }));
	if (velocity >= SHEET_FLING_VELOCITY) {
		const up = ascending.find(({ h }) => h > heightPx + 1);
		return (up ?? ascending[ascending.length - 1]).snap;
	}
	if (velocity <= -SHEET_FLING_VELOCITY) {
		const down = [...ascending].reverse().find(({ h }) => h < heightPx - 1);
		return (down ?? ascending[0]).snap;
	}
	return nearestSnap(heightPx, viewportHeight);
}

// Move one snap taller (+1) or shorter (-1), clamped at the ends. Used by the
// grip's Arrow keys.
export function stepSnap(snap: SheetSnap, direction: 1 | -1): SheetSnap {
	const index = SHEET_SNAPS.indexOf(snap);
	const next = Math.min(SHEET_SNAPS.length - 1, Math.max(0, index + direction));
	return SHEET_SNAPS[next];
}

// The next snap for a tap on the grip: peek → half → full → peek. Wraps so
// repeated taps keep cycling rather than sticking at full.
export function cycleSnap(snap: SheetSnap): SheetSnap {
	const index = SHEET_SNAPS.indexOf(snap);
	return SHEET_SNAPS[(index + 1) % SHEET_SNAPS.length];
}
