<script lang="ts">
	import { fade } from 'svelte/transition';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { PLACES_PATH } from '$lib/browse';
	import { m } from '$lib/paraglide/messages';

	let {
		onstart
	}: {
		// "Start using": fly the map to the visitor's location. The parent owns the fly.
		onstart: () => void;
	} = $props();
</script>

<!-- The landing overlay over the zoomed-out globe: a single actions block pinned to
     the bottom (the "Start using" CTA plus a crawlable browse entry). No card chrome —
     just controls floating on the map. The backdrop passes pointers through (so a drag
     on the globe still pans, and zooming in dismisses the landing); only the button and
     link take clicks. -->
<div class="overlay" transition:fade={{ duration: 200 }}>
	<section class="actions" aria-label={m.landing_actions_aria()}>
		<button type="button" class="cta" onclick={onstart}>
			<MapPin size={18} aria-hidden="true" />
			{m.landing_cta()}
		</button>

		<!-- A crawlable entry into the geographic browse tree (#217), so the whole
		     interlinked city/diet index is reachable from `/` — this <a> is in the
		     SSR'd landing (the overlay renders at the opening zoom). -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- static internal href ($lib/browse); no base path — see +page.svelte precedent -->
		<a class="browse-link" href={PLACES_PATH}>{m.landing_browse_link()}</a>
	</section>
</div>

<style>
	/* Spans the map above the floating search/results panels (z-index 10) but below
	   the menu popup (z-index 20). A bottom-aligned column pins the actions block to
	   the bottom, leaving the zoomed-out globe visible above it. The backdrop passes
	   pointers through. */
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 15;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		align-items: center;
		gap: 1rem;
		padding: calc(1rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left));
		pointer-events: none;
	}

	/* No card chrome — the actions float as plain controls on the map. The container
	   lays out its contents but passes pointers straight through, so only the
	   interactive children inside (.cta / .browse-link) capture clicks; everywhere
	   else the globe drags. */
	.actions {
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		width: min(36rem, 100%);
		text-align: center;
	}

	/* The primary action — accent-filled so "Start using the map" is unmistakable.
	   pointer-events re-enabled here (the floating container passes them through). */
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

	/* The secondary browse entry under the CTA, sitting on dark space below the globe.
	   pointer-events re-enabled (the floating container passes them through); brightened
	   green with a dark drop so it stays legible on the near-black backdrop. */
	.browse-link {
		pointer-events: auto;
		font-size: 0.9rem;
		font-weight: 600;
		color: #7cc79f;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
	}
</style>
