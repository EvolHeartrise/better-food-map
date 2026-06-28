<script lang="ts">
	import { fade } from 'svelte/transition';
	import MapPin from '@lucide/svelte/icons/map-pin';

	// Coverage totals shown on the zoomed-out landing. Structural (not imported from
	// the server db module) so the overlay carries no server-only import — mirroring
	// how LocationMap keeps its own prop types.
	type Stats = {
		locations: number;
		items: number;
		cities: number;
	};

	let {
		stats,
		onstart
	}: {
		// Null until the counts resolve; each figure shows a placeholder until then.
		stats: Stats | null;
		// "Start using": fly the map to the visitor's location. The parent owns the fly.
		onstart: () => void;
	} = $props();

	const numberFormat = new Intl.NumberFormat('en-CA');
	function fmt(value: number | undefined): string {
		return value === undefined ? '—' : numberFormat.format(value);
	}

	// The figures, in display order.
	const figures = $derived([
		{ value: stats?.locations, label: 'venues' },
		{ value: stats?.items, label: 'menu items' },
		{ value: stats?.cities, label: 'cities' }
	]);
</script>

<!-- Two floating pieces over the zoomed-out globe: an intro pinned to the top and an
     actions block pinned to the bottom, with the globe visible in the gap between them.
     No card chrome — just text and controls floating on the map. The backdrop and the
     non-interactive text pass pointers through (so a drag on the globe still pans, and
     zooming in dismisses the landing); only the button takes clicks. -->
<div class="overlay" transition:fade={{ duration: 200 }}>
	<section class="intro" aria-label="About BetterFoodMaps">
		<p class="intro__brand">🍴 BetterFoodMaps</p>
		<h1 class="intro__title">Find food that fits your diet, anywhere on the map.</h1>
	</section>

	<section class="actions" aria-label="Coverage and getting started">
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
	</section>
</div>

<style>
	/* Spans the map above the floating search/results panels (z-index 10) but below
	   the menu popup (z-index 20). A top/bottom column with space-between pins the
	   intro card to the top and the actions card to the bottom, leaving the zoomed-out
	   globe visible in the gap between them. The backdrop passes pointers through. */
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 15;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: calc(1rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left));
		pointer-events: none;
	}

	/* No card chrome — the two pieces float as plain text/controls on the map. They lay
	   out their contents but pass pointers straight through, so only the interactive
	   button inside (.cta) captures clicks; everywhere else the globe drags. */
	.intro,
	.actions {
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		width: min(36rem, 100%);
		text-align: center;
	}

	/* Floating over live map tiles, so every text element carries a soft light halo to
	   stay legible whatever it sits over (land, ocean, the globe's dark edge). */
	.intro__brand,
	.intro__title,
	.stat__value,
	.stat__label {
		text-shadow:
			0 1px 2px rgba(255, 255, 255, 0.9),
			0 0 12px rgba(255, 255, 255, 0.7);
	}

	.intro__brand {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 650;
		letter-spacing: 0.01em;
		color: var(--color-accent);
	}

	.intro__title {
		margin: 0;
		font-size: clamp(1.5rem, 3.5vw, 2.2rem);
		line-height: 1.15;
		color: var(--color-text);
	}

	/* The coverage figures, laid out as an even grid so the numbers line up. */
	.stats {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem 1.5rem;
		width: 100%;
		margin: 0;
		padding: 0;
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

	/* The primary action — accent-filled so "Start using the map" is unmistakable.
	   pointer-events re-enabled here (the floating containers pass them through). */
	.cta {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
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
</style>
