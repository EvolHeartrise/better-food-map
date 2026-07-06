// Pure placement math for the shared tooltip ($lib/tooltip). Split from the DOM
// action so the flip/clamp behaviour is unit-testable without a browser: given
// the anchor's viewport rect and the measured tooltip size, decide which side of
// the anchor the bubble sits on and where, and where the arrow points.

export interface AnchorRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface TooltipPlacement {
	/** Side of the anchor the bubble sits on; the arrow sits on the opposite edge. */
	side: 'top' | 'bottom';
	/** Viewport (fixed-position) coordinates of the bubble's top-left corner. */
	top: number;
	left: number;
	/** Arrow centre, in px from the bubble's left edge — tracks the anchor even
	 * when the bubble itself is clamped to the viewport edge. */
	arrowLeft: number;
}

/** Gap between the anchor edge and the bubble (the arrow lives inside it). */
export const TOOLTIP_GAP = 6;
/** Minimum clearance kept between the bubble and the viewport edges. */
export const TOOLTIP_MARGIN = 8;
/** The arrow is an 8px rotated square; keep its centre this far inside the
 * bubble so it never pokes past the rounded corners. */
const ARROW_INSET = 10;

export function placeTooltip(
	anchor: AnchorRect,
	tip: { width: number; height: number },
	viewport: { width: number; height: number }
): TooltipPlacement {
	// Prefer sitting above the anchor; flip below only when the bubble wouldn't
	// clear the top margin (and below when neither fits — a top-edge anchor).
	const fitsAbove = anchor.top - TOOLTIP_GAP - tip.height >= TOOLTIP_MARGIN;
	const side = fitsAbove ? 'top' : 'bottom';
	const top = fitsAbove
		? anchor.top - TOOLTIP_GAP - tip.height
		: anchor.top + anchor.height + TOOLTIP_GAP;

	const anchorCenter = anchor.left + anchor.width / 2;
	const maxLeft = Math.max(TOOLTIP_MARGIN, viewport.width - TOOLTIP_MARGIN - tip.width);
	const left = Math.min(Math.max(anchorCenter - tip.width / 2, TOOLTIP_MARGIN), maxLeft);

	const arrowLeft = Math.min(
		Math.max(anchorCenter - left, ARROW_INSET),
		Math.max(tip.width - ARROW_INSET, ARROW_INSET)
	);

	return { side, top, left, arrowLeft };
}
