// The narrow-screen venue sheet's dismiss math — a pure module so
// scripts/bottom-sheet.test.ts can pin the release rule without a DOM.
//
// On a phone the venue detail panel is a FULL-SCREEN sheet: tapping a venue
// slides it up over the whole viewport, and there are no intermediate resting
// heights. The only gesture is the dismiss: a downward swipe slides the sheet
// down with the finger (a translateY offset from its resting position — the
// sheet is never resized, so its geometry can't drift from the viewport), and
// on release it either closes (returning to the map) or springs back up. The
// ✕ button closes it too.

// A flick faster than this (px per millisecond of downward offset change)
// dismisses the sheet regardless of how far it has been dragged.
export const SHEET_FLING_VELOCITY = 0.5;

// Whether a released drag dismisses the sheet. `offsetPx` is how far the sheet
// has been dragged down from resting (0 = fully up), `velocity` the offset's
// rate of change at release (px/ms, + = moving down), `panelHeight` the
// sheet's full height. A firm downward flick always dismisses; a firm upward
// flick always springs back (the user is visibly pushing it back up, however
// far it had been dragged); otherwise the sheet closes when released more than
// halfway off the screen, and springs back above that.
export function shouldDismissSheet(
	offsetPx: number,
	velocity: number,
	panelHeight: number
): boolean {
	if (velocity >= SHEET_FLING_VELOCITY) return true;
	if (velocity <= -SHEET_FLING_VELOCITY) return false;
	return offsetPx > panelHeight / 2;
}
