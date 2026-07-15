<script lang="ts">
	import Star from '@lucide/svelte/icons/star';

	// A 5-star rating control. Two modes:
	//   • interactive (`onRate` set) — the viewer's OWN rating: a radio-group of five
	//     stars, hover/focus previews the fill, click/Enter/Space or arrow keys set it.
	//     A bare tap here sets ONLY the rating (the parent's setter omits body, so text
	//     is preserved). `value` 0 means "not yet rated".
	//   • read-only (`onRate` omitted) — an aggregate/other rating, rendered as filled
	//     stars to the nearest whole; the precise number lives beside it as text.
	let {
		value,
		onRate,
		size = 20,
		groupLabel,
		starLabel
	}: {
		/** Current rating 0–5 (0 = none; may be fractional in read-only mode). */
		value: number;
		/** When set, the control is interactive and calls this with the chosen 1–5. */
		onRate?: (rating: number) => void;
		size?: number;
		/** Accessible group label, e.g. "Your rating". */
		groupLabel?: string;
		/** Per-star accessible label builder, e.g. (n) => `Rate ${n} of 5 stars`. */
		starLabel?: (n: number) => string;
	} = $props();

	const interactive = $derived(onRate !== undefined);
	// While hovering/focusing a star, preview the fill up to it; else show `value`.
	let preview = $state(0);
	const shown = $derived(preview || value);

	function choose(n: number): void {
		onRate?.(n);
	}

	function onKeydown(e: KeyboardEvent): void {
		if (!interactive) return;
		const current = Math.round(value);
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
			e.preventDefault();
			choose(Math.min(5, current + 1));
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
			e.preventDefault();
			choose(Math.max(1, current - 1));
		}
	}
</script>

{#if interactive}
	<div
		class="stars stars--interactive"
		role="radiogroup"
		aria-label={groupLabel}
		tabindex={-1}
		onmouseleave={() => (preview = 0)}
	>
		{#each [1, 2, 3, 4, 5] as n (n)}
			<button
				type="button"
				class="star"
				role="radio"
				aria-checked={Math.round(value) === n}
				aria-label={starLabel ? starLabel(n) : `${n}`}
				tabindex={Math.round(value) === n || (value === 0 && n === 1) ? 0 : -1}
				onclick={() => choose(n)}
				onkeydown={onKeydown}
				onmouseenter={() => (preview = n)}
				onfocus={() => (preview = n)}
				onblur={() => (preview = 0)}
			>
				<Star {size} fill={n <= shown ? 'currentColor' : 'none'} aria-hidden="true" />
			</button>
		{/each}
	</div>
{:else}
	<div class="stars" aria-hidden="true">
		{#each [1, 2, 3, 4, 5] as n (n)}
			<Star {size} fill={n <= Math.round(value) ? 'currentColor' : 'none'} />
		{/each}
	</div>
{/if}

<style>
	.stars {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		color: #f59e0b;
		line-height: 0;
	}

	.stars:not(.stars--interactive) {
		/* Read-only aggregate stars: unfilled stars are muted so the fill reads clearly. */
		color: #f59e0b;
	}

	.star {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.15rem;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
		line-height: 0;
		border-radius: 4px;
		transition: transform 0.1s ease;
	}

	.star:hover {
		transform: scale(1.1);
	}

	.star:active {
		transform: scale(0.92);
	}

	.star:focus-visible {
		outline: 2px solid #f59e0b;
		outline-offset: 1px;
	}

	@media (pointer: coarse) {
		.star {
			padding: 0.35rem;
		}
	}
</style>
