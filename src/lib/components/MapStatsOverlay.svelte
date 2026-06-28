<script lang="ts">
	import { fade } from 'svelte/transition';
	import X from '@lucide/svelte/icons/x';
	import MapPin from '@lucide/svelte/icons/map-pin';

	// Coverage totals shown on the zoomed-out landing. Structural (not imported from
	// the server db module) so the overlay carries no server-only import — mirroring
	// how LocationMap keeps its own prop types.
	type Stats = {
		locations: number;
		items: number;
		cities: number;
		countries: number;
	};

	let {
		stats,
		onstart,
		onclose
	}: {
		// Null until the counts resolve; each figure shows a placeholder until then.
		stats: Stats | null;
		// "Start using": fly the map to the visitor's location. The parent owns the fly.
		onstart: () => void;
		// Dismiss the overlay to browse the whole map from the zoomed-out view.
		onclose: () => void;
	} = $props();

	const numberFormat = new Intl.NumberFormat('en-CA');
	function fmt(value: number | undefined): string {
		return value === undefined ? '—' : numberFormat.format(value);
	}

	// The figures, in display order. `countries` is the only one that can realistically
	// be 1, so it's the only label that bothers to singularise.
	const figures = $derived([
		{ value: stats?.locations, label: 'venues' },
		{ value: stats?.items, label: 'menu items' },
		{ value: stats?.cities, label: 'cities' },
		{ value: stats?.countries, label: stats?.countries === 1 ? 'country' : 'countries' }
	]);
</script>

<!-- The backdrop spans the map but is transparent to pointers, so a drag on the map
     behind it still pans (and dismisses, via the map's oninteract). Only the card
     itself captures clicks. -->
<div class="overlay" transition:fade={{ duration: 200 }}>
	<section class="card" aria-label="About BetterFoodMaps">
		<button type="button" class="card__close" aria-label="Dismiss" onclick={onclose}>
			<X size={18} aria-hidden="true" />
		</button>

		<p class="card__brand">🍴 BetterFoodMaps</p>
		<h1 class="card__title">Find food that fits your diet, anywhere on the map.</h1>
		<p class="card__tagline">
			Search restaurants, cafes and fast food by what's actually on the menu — vegan, gluten-free,
			halal and more.
		</p>

		<ul class="stats">
			{#each figures as figure (figure.label)}
				<li class="stat">
					<span class="stat__value">{fmt(figure.value)}</span>
					<span class="stat__label">{figure.label}</span>
				</li>
			{/each}
		</ul>

		<button type="button" class="cta" onclick={onstart}>
			<MapPin size={18} aria-hidden="true" />
			Start using the map
		</button>
		<button type="button" class="card__browse" onclick={onclose}> or browse the whole map </button>
	</section>
</div>

<style>
	/* Sits above the floating search/results panels (z-index 10) but below the menu
	   popup (z-index 20). Centres the card; the backdrop passes pointers through. */
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 15;
		display: grid;
		place-items: center;
		padding: 1rem calc(1rem + env(safe-area-inset-right)) calc(1rem + env(safe-area-inset-bottom))
			calc(1rem + env(safe-area-inset-left));
		pointer-events: none;
	}

	.card {
		pointer-events: auto;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		width: min(32rem, 100%);
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		padding: 2rem 1.75rem;
		text-align: center;
		border-radius: 1.25rem;
		background: rgba(255, 255, 255, 0.82);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2);
	}

	.card__close {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		color: var(--color-text-muted);
		background: rgba(255, 255, 255, 0.6);
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.card__close:hover {
		color: var(--color-text);
		background: rgba(255, 255, 255, 0.95);
	}

	.card__close:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.card__brand {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 650;
		letter-spacing: 0.01em;
		color: var(--color-accent);
	}

	.card__title {
		margin: 0;
		font-size: clamp(1.5rem, 3.5vw, 2.2rem);
		line-height: 1.15;
		color: var(--color-text);
	}

	.card__tagline {
		margin: 0;
		font-size: 1rem;
		color: var(--color-text-muted);
	}

	/* The four coverage figures, laid out as an even grid so the numbers line up. */
	.stats {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.5rem 1rem;
		width: 100%;
		margin: 0.5rem 0;
		padding: 1rem 0;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		border-bottom: 1px solid rgba(0, 0, 0, 0.08);
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.stat__value {
		font-size: clamp(1.2rem, 4vw, 1.6rem);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}

	.stat__label {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	/* The primary action — accent-filled so "Start using the map" is unmistakable. */
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		padding: 0.75rem 1.4rem;
		border: none;
		border-radius: 0.8rem;
		background: var(--color-accent);
		color: #fff;
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		box-shadow: 0 6px 20px color-mix(in srgb, var(--color-accent) 35%, transparent);
		transition:
			background-color 0.12s,
			transform 0.12s;
	}

	.cta:hover {
		background: var(--color-accent-hover);
	}

	.cta:active {
		transform: translateY(1px);
	}

	.cta:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.card__browse {
		padding: 0.2rem 0.4rem;
		border: none;
		background: none;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 0.85rem;
		text-decoration: underline;
		cursor: pointer;
	}

	.card__browse:hover {
		color: var(--color-text);
	}

	.card__browse:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 0.3rem;
	}

	/* On narrow screens the four figures don't fit abreast; drop to two columns. */
	@media (max-width: 30rem) {
		.stats {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
