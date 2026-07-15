<script lang="ts">
	import Bookmark from '@lucide/svelte/icons/bookmark';
	import { tooltip } from '$lib/tooltip';

	// A small bookmark (save) toggle. Presentational: the parent owns the saved state
	// and the remote mutation, so this just renders and reports clicks. Rendered as a
	// sibling of (never nested inside) the result/menu buttons it sits over, so a click
	// here saves the item without also triggering the surrounding card. Replaces the
	// old heart's private-save role (migration 0029).
	let {
		saved,
		onToggle,
		label,
		size = 16
	}: {
		saved: boolean;
		onToggle: () => void;
		/** Accessible label, e.g. "Save this place" / "Remove from saved". */
		label: string;
		size?: number;
	} = $props();
</script>

<button
	type="button"
	class="bookmark"
	class:bookmark--on={saved}
	aria-pressed={saved}
	aria-label={label}
	use:tooltip={label}
	onclick={onToggle}
>
	<Bookmark {size} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
</button>

<style>
	.bookmark {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.3rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		/* Idle stroke: 55% black keeps a quiet look and clears the WCAG 1.4.11 floor
		   even where the glass surface darkens (matches the old heart). */
		color: rgba(0, 0, 0, 0.55);
		cursor: pointer;
		line-height: 0;
		transition:
			color 0.15s ease,
			background 0.15s ease,
			transform 0.1s ease;
	}

	/* Touch targets: the icon is deliberately small so it fits a tight menu row, but
	   that's under the 44px iOS / 48dp Android floor. On a coarse pointer, extend the
	   *tappable* area to 44px with a transparent overlay centred on the button. */
	@media (pointer: coarse) {
		.bookmark::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 44px;
			height: 44px;
			transform: translate(-50%, -50%);
		}
	}

	.bookmark:hover {
		color: #2563eb;
		background: rgba(37, 99, 235, 0.1);
	}

	.bookmark:active {
		transform: scale(0.9);
	}

	.bookmark--on {
		color: #2563eb;
	}

	.bookmark:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}
</style>
