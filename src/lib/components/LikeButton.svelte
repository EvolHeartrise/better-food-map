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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.3rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: rgba(0, 0, 0, 0.4);
		cursor: pointer;
		line-height: 0;
		transition:
			color 0.15s ease,
			background 0.15s ease,
			transform 0.1s ease;
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
