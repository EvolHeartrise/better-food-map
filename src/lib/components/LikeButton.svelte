<script lang="ts">
	import Heart from '@lucide/svelte/icons/heart';
	import { tooltip } from '$lib/tooltip';

	// A small heart toggle. Presentational: the parent owns the liked state and the
	// remote mutation, so this just renders and reports clicks. Rendered as a sibling
	// of (never nested inside) the result/menu buttons it sits over, so a click here
	// likes the item without also triggering the surrounding card.
	let {
		liked,
		onToggle,
		label,
		size = 16
	}: {
		liked: boolean;
		onToggle: () => void;
		/** Accessible label, e.g. "Like this place" / "Unlike this place". */
		label: string;
		size?: number;
	} = $props();
</script>

<button
	type="button"
	class="like"
	class:like--on={liked}
	aria-pressed={liked}
	aria-label={label}
	use:tooltip={label}
	onclick={onToggle}
>
	<Heart {size} fill={liked ? 'currentColor' : 'none'} aria-hidden="true" />
</button>

<style>
	.like {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.3rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		/* Idle stroke: 40% black sits at ≈3:1 on the panel and dips below the WCAG 1.4.11
		   floor where the glass surface darkens; 55% keeps the quiet look and clears the bar. */
		color: rgba(0, 0, 0, 0.55);
		cursor: pointer;
		line-height: 0;
		transition:
			color 0.15s ease,
			background 0.15s ease,
			transform 0.1s ease;
	}

	/* Touch targets: the heart is deliberately small (~26px) so it fits a tight menu
	   row beside the price, but that's under the 44px iOS / 48dp Android floor. On a
	   coarse pointer, extend the *tappable* area to 44px with a transparent overlay
	   centred on the button — the visible heart is unchanged, and the wider hit area
	   makes it far harder to miss (or tap the wrong row) with a fingertip. */
	@media (pointer: coarse) {
		.like::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 44px;
			height: 44px;
			transform: translate(-50%, -50%);
		}
	}

	.like:hover {
		color: #e0245e;
		background: rgba(224, 36, 94, 0.1);
	}

	.like:active {
		transform: scale(0.9);
	}

	.like--on {
		color: #e0245e;
	}

	.like:focus-visible {
		outline: 2px solid #e0245e;
		outline-offset: 1px;
	}
</style>
