// The narrow-screen venue sheet's dismiss math — a pure module so
// scripts/bottom-sheet.test.ts can pin the release rule without a DOM.
//
// On a phone the venue detail panel is a FULL-SCREEN sheet: tapping a venue
// slides it up over the whole viewport, and there are no intermediate resting
// heights. The only gesture is the dismiss: a downward swipe drags the sheet
// with the finger, and on release it either closes (returning to the map) or
// springs back to full. The ✕ button closes it too.

// A flick faster than this (px per millisecond of height change, − = shrinking)
// dismisses the sheet regardless of how far it has been dragged.
export const SHEET_FLING_VELOCITY = 0.5;

// The viewport height assumed before the first client measure (SSR /
// pre-hydration), where `innerHeight.current` is undefined. A plausible phone
// height so the drag math has something sane to clamp against that first frame.
export const FALLBACK_VIEWPORT_H = 800;

// Whether a released drag dismisses the sheet. A firm downward flick always
// dismisses; a firm upward flick always springs back to full (the user is
// visibly pulling it back up, however far it had been dragged); otherwise the
// sheet closes when it was released with less than half the screen still
// covered, and springs back above that.
export function shouldDismissSheet(
	heightPx: number,
	velocity: number,
	viewportHeight: number
): boolean {
	if (velocity <= -SHEET_FLING_VELOCITY) return true;
	if (velocity >= SHEET_FLING_VELOCITY) return false;
	return heightPx < viewportHeight / 2;
}
