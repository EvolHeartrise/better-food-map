// Shared window-level dismiss wiring for the floating popovers (AccountMenu, DietSelector):
// Escape closes from anywhere and — when focus is still inside the control — hands it back
// to the trigger so closing can't drop focus to <body>; a pointerdown outside the control
// closes it too, leaving focus where the user put it. Both are handled on the window so the
// wrapper stays a plain, role-free element with no open/close state churned from an $effect.
//
// The caller passes accessors (not values) so each handler reads the live open-state and the
// current element bindings at call time — `open` may be a bindable prop or local $state, and
// the trigger binding can be reassigned as different triggers render.
export interface PopoverDismissControls {
	/** Whether the popover is currently open. */
	isOpen: () => boolean;
	/** Close the popover (set open = false). */
	close: () => void;
	/** The control's root element (trigger + popover live inside it). */
	getRoot: () => HTMLElement | undefined;
	/** The trigger element focus returns to. */
	getTrigger: () => HTMLElement | undefined;
}

export function createPopoverDismiss(controls: PopoverDismissControls) {
	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && controls.isOpen()) {
			event.preventDefault();
			controls.close();
			if (controls.getRoot()?.contains(document.activeElement)) controls.getTrigger()?.focus();
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (!controls.isOpen()) return;
		const root = controls.getRoot();
		if (root && !root.contains(event.target as Node | null)) controls.close();
	}

	return { onWindowKeydown, onWindowPointerDown };
}
