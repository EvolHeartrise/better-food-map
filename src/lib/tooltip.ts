// Shared hover tooltip: `use:tooltip={'label'}` replaces the browser-native
// `title` attribute everywhere. One module-level bubble element serves every
// trigger — a singleton by construction, so two tooltips can never be visible
// at once and hovering quickly between triggers repositions the same bubble
// instantly instead of replaying open/close animations. It shows with no
// hover delay, fading in with a slight fly towards the anchor (the direction
// the arrow points), flips below the anchor when there's no room above, and
// clamps to the viewport (see $lib/tooltip-position for the math). Styling
// lives in app.css under `.tooltip` since the bubble is appended to
// document.body, outside any component's scoped styles.

import { placeTooltip } from './tooltip-position';

const TOOLTIP_ID = 'app-tooltip';

let bubble: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let arrowEl: HTMLDivElement | null = null;
let currentAnchor: HTMLElement | null = null;

function ensureBubble(): void {
	if (bubble) return;
	bubble = document.createElement('div');
	bubble.className = 'tooltip';
	bubble.id = TOOLTIP_ID;
	bubble.setAttribute('role', 'tooltip');
	textEl = document.createElement('span');
	arrowEl = document.createElement('div');
	arrowEl.className = 'tooltip__arrow';
	bubble.appendChild(textEl);
	bubble.appendChild(arrowEl);
	document.body.appendChild(bubble);

	// The anchor can move under an open tooltip (panel scroll, viewport resize):
	// track it rather than showing a stale bubble. Registered once for the app's
	// lifetime; both are no-ops while nothing is shown.
	window.addEventListener('scroll', reposition, { capture: true, passive: true });
	window.addEventListener('resize', reposition);
	window.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && currentAnchor) hide(currentAnchor);
	});
}

function reposition(): void {
	if (!currentAnchor || !bubble || !arrowEl) return;
	const anchorRect = currentAnchor.getBoundingClientRect();
	const placed = placeTooltip(
		anchorRect,
		{ width: bubble.offsetWidth, height: bubble.offsetHeight },
		{ width: window.innerWidth, height: window.innerHeight }
	);
	bubble.dataset.side = placed.side;
	bubble.style.top = `${placed.top}px`;
	bubble.style.left = `${placed.left}px`;
	arrowEl.style.left = `${placed.arrowLeft}px`;
}

function show(anchor: HTMLElement, text: string): void {
	ensureBubble();
	if (!bubble || !textEl) return;
	const wasVisible = currentAnchor !== null;
	if (currentAnchor && currentAnchor !== anchor) {
		currentAnchor.removeAttribute('aria-describedby');
	}
	currentAnchor = anchor;
	anchor.setAttribute('aria-describedby', TOOLTIP_ID);

	textEl.textContent = text;
	bubble.classList.add('tooltip--visible');
	reposition();

	// Play the fade/fly entrance only on a fresh open. When the bubble is
	// already up (hopping between adjacent triggers) it must jump to the new
	// anchor with no animation, so the class stays as-is and never restarts.
	if (!wasVisible) {
		bubble.classList.remove('tooltip--in');
		void bubble.offsetWidth;
		bubble.classList.add('tooltip--in');
	}
}

function hide(anchor: HTMLElement): void {
	if (currentAnchor !== anchor) return;
	currentAnchor = null;
	anchor.removeAttribute('aria-describedby');
	bubble?.classList.remove('tooltip--visible', 'tooltip--in');
}

/**
 * Svelte action. `text` of undefined/empty means "no tooltip" (mirrors how an
 * absent `title` behaved), and updates while shown re-render in place.
 */
export function tooltip(node: HTMLElement, text: string | undefined) {
	let current = text;

	const open = () => {
		if (current) show(node, current);
	};
	const close = () => hide(node);
	const onFocus = () => {
		// Keyboard focus only — a pointer click already has the hover tooltip,
		// and re-showing it on mousedown-focus makes it flash after activation.
		if (node.matches(':focus-visible')) open();
	};

	node.addEventListener('pointerenter', open);
	node.addEventListener('pointerleave', close);
	node.addEventListener('pointerdown', close);
	node.addEventListener('focus', onFocus);
	node.addEventListener('blur', close);

	return {
		update(next: string | undefined) {
			current = next;
			if (currentAnchor !== node) return;
			if (current) show(node, current);
			else hide(node);
		},
		destroy() {
			node.removeEventListener('pointerenter', open);
			node.removeEventListener('pointerleave', close);
			node.removeEventListener('pointerdown', close);
			node.removeEventListener('focus', onFocus);
			node.removeEventListener('blur', close);
			hide(node);
		}
	};
}
