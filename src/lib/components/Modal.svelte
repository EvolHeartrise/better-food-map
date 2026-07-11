<script lang="ts">
	import type { Snippet } from 'svelte';

	// A native-<dialog> modal shell shared by SourcesModal and DirectionsModal. It owns
	// nothing but its DOM: `open` is bindable so the page can layer its own Escape
	// handling under this one (Escape closes only the topmost layer — see the page's
	// onWindowKeydown). A native <dialog> in the top layer gives the backdrop, focus
	// trap and Escape-to-close for free. Callers supply the title/aria strings (from the
	// message catalog) and the list body as children; `width`/`maxHeight` let a caller
	// size the box.
	let {
		open = $bindable(false),
		title,
		ariaLabel,
		closeLabel,
		width,
		maxHeight,
		children
	}: {
		open?: boolean;
		title: string;
		ariaLabel: string;
		closeLabel: string;
		width?: string;
		maxHeight?: string;
		children: Snippet;
	} = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	// Drive the platform modal from `open`. showModal() puts the dialog in the top
	// layer above the map and detail panel; close() (Escape, backdrop, ✕) fires the
	// `close` event below, which syncs `open` back to false.
	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	// A click outside the dialog box (on the backdrop) closes it. The dialog element
	// fills only the box, so a pointer landing beyond its bounds is a backdrop click.
	function onDialogClick(event: MouseEvent) {
		const el = dialog;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const outside =
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom;
		if (outside) open = false;
	}
</script>

<dialog
	bind:this={dialog}
	class="modal"
	style:width
	style:max-height={maxHeight}
	aria-label={ariaLabel}
	onclose={() => (open = false)}
	onclick={onDialogClick}
>
	<div class="modal__panel">
		<header class="modal__head">
			<h2 class="modal__title">{title}</h2>
			<button
				type="button"
				class="modal__close"
				aria-label={closeLabel}
				onclick={() => (open = false)}
			>
				✕
			</button>
		</header>

		{@render children()}
	</div>
</dialog>

<style>
	/* The dialog element IS the box (native modal, so it lives in the top layer over
	   the map and detail panel regardless of z-index). Reset the UA centring margins
	   and place it in the viewport centre ourselves. */
	.modal {
		margin: auto;
		width: min(24rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.96);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
		color: var(--color-text);
		overflow: hidden;
	}

	.modal::backdrop {
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.modal__panel {
		display: flex;
		flex-direction: column;
		max-height: inherit;
		padding: 0.85rem 0.95rem 1rem;
	}

	.modal__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.modal__title {
		margin: 0;
		font-size: 1rem;
	}

	.modal__close {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		flex-shrink: 0;
		font-size: 0.8rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.04);
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.modal__close:hover {
		color: var(--color-text);
		background: rgba(0, 0, 0, 0.09);
	}

	/* Touch target: keep the 1.6rem ✕, but extend the tappable area to the 44px
	   floor on coarse pointers with a transparent centred overlay. */
	@media (pointer: coarse) {
		.modal__close::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 44px;
			height: 44px;
			transform: translate(-50%, -50%);
		}
	}
</style>
