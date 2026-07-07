<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Spring, prefersReducedMotion } from 'svelte/motion';
	import { SvelteSet } from 'svelte/reactivity';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { PLACES_PATH } from '$lib/browse';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

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
		// Null until the counts resolve; the figures hold at "—" until then.
		stats: Stats | null;
		// "Start using": fly the map to the visitor's location. The parent owns the fly.
		onstart: () => void;
	} = $props();

	// Built from the active per-page locale (fixed per page load), so coverage
	// counts group digits the reader's way (en `1,234` vs fr `1 234`).
	const numberFormat = new Intl.NumberFormat(getLocale());
	function fmt(value: number): string {
		return numberFormat.format(Math.round(value));
	}

	// Count the figures up from zero. The overlay is mounted afresh whenever the landing
	// appears (the parent's `{#if landing}`), so the spring starts at 0 every time and
	// springs up to the totals — re-running the count-up on each appearance. `damping: 1`
	// keeps it from overshooting (a count that flies past then settles reads as a glitch);
	// reduced-motion users get the final numbers instantly.
	const counts = new Spring({ locations: 0, items: 0, cities: 0 }, { stiffness: 0.08, damping: 1 });
	$effect(() => {
		if (!stats) return;
		counts.set(
			{ locations: stats.locations, items: stats.items, cities: stats.cities },
			{ instant: prefersReducedMotion.current }
		);
	});

	// The figures, in display order, reading the live (animating) spring values.
	// `key` is the stable {#each} identity (locale-independent); `label` is the
	// localized text shown under the count.
	const figures = $derived([
		{ key: 'venues', value: counts.current.locations, label: m.stat_venues() },
		{ key: 'items', value: counts.current.items, label: m.stat_menu_items() },
		{ key: 'cities', value: counts.current.cities, label: m.stat_cities() }
	]);

	// --- Ambient stat drift ---------------------------------------------------
	// The coverage figures aren't a fixed panel: each one drifts through the empty
	// space around the globe, fading in at a random edge slot, holding, fading out,
	// then reappearing elsewhere — so the numbers feel like they're floating in the
	// starfield. Slots hug the viewport corners/edges (never the centre, where the
	// globe and the intro/CTA sit), so a figure lands on dark space, not on the globe.
	const SLOTS: Array<Record<string, string>> = [
		{ top: '11%', left: '6%' },
		{ top: '11%', right: '6%' },
		{ top: '30%', left: '4%' },
		{ top: '30%', right: '4%' },
		{ bottom: '32%', left: '6%' },
		{ bottom: '32%', right: '6%' },
		{ bottom: '15%', left: '11%' },
		{ bottom: '15%', right: '11%' }
	];
	const FADE_MS = 1100;
	// Fixed figure count — used instead of reading `figures` (which is spring-derived
	// and changes every frame during the count-up) so the drift timers below aren't
	// torn down and restarted on every animation frame.
	const STAT_COUNT = 3;

	function slotStyle(slot: number): string {
		return Object.entries(SLOTS[slot] ?? SLOTS[0])
			.map(([k, v]) => `${k}:${v}`)
			.join(';');
	}

	// One entry per figure: whether it's currently shown and which slot it occupies.
	let floats = $state(Array.from({ length: STAT_COUNT }, () => ({ visible: false, slot: 0 })));

	// Drive the drift with self-rescheduling timers (one chain per figure), keeping a
	// shared `occupied` set so two figures never land on the same slot. Reduced-motion
	// users get the numbers pinned to distinct slots, always visible, with no fading.
	$effect(() => {
		if (prefersReducedMotion.current) {
			const picks = pickDistinct(STAT_COUNT);
			floats = Array.from({ length: STAT_COUNT }, (_, i) => ({ visible: true, slot: picks[i] }));
			return;
		}

		let alive = true;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const occupied = new SvelteSet<number>();
		const wait = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

		function appear(i: number) {
			if (!alive) return;
			const slot = pickFreeSlot(occupied);
			occupied.add(slot);
			floats[i] = { visible: true, slot };
			// Hold on screen for a random spell, then fade out.
			wait(2600 + Math.random() * 2800, () => {
				if (!alive) return;
				floats[i] = { ...floats[i], visible: false };
				// Free the slot only once the fade-out has finished, then, after a
				// random gap, reappear somewhere else.
				wait(FADE_MS, () => {
					occupied.delete(slot);
					wait(500 + Math.random() * 1900, () => appear(i));
				});
			});
		}

		// Stagger the initial reveals so they don't all pop in together.
		for (let i = 0; i < STAT_COUNT; i++) {
			wait(300 + Math.random() * 2000, () => appear(i));
		}

		return () => {
			alive = false;
			for (const t of timers) clearTimeout(t);
		};
	});

	// A random slot index not currently taken by a visible figure.
	function pickFreeSlot(occupied: Set<number>): number {
		const free = SLOTS.map((_, i) => i).filter((i) => !occupied.has(i));
		const pool = free.length > 0 ? free : SLOTS.map((_, i) => i);
		return pool[Math.floor(Math.random() * pool.length)];
	}

	// `n` distinct slot indices (for the static reduced-motion layout).
	function pickDistinct(n: number): number[] {
		const idx = SLOTS.map((_, i) => i);
		for (let i = idx.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[idx[i], idx[j]] = [idx[j], idx[i]];
		}
		return idx.slice(0, n);
	}
</script>

<!-- Three floating pieces over the zoomed-out globe: an intro pinned to the top, an
     actions block pinned to the bottom, and the coverage figures drifting through the
     space around the globe in between. No card chrome — just text and controls floating
     on the map. The backdrop and the non-interactive text pass pointers through (so a
     drag on the globe still pans, and zooming in dismisses the landing); only the button
     takes clicks. -->
<div class="overlay" transition:fade={{ duration: 200 }}>
	<section class="intro" aria-label={m.landing_intro_aria()}>
		<p class="intro__brand">🍴 BetterFoodMaps</p>
		<h1 class="intro__title">{m.landing_title()}</h1>
	</section>

	<!-- The coverage figures, drifting in the space around the globe (see the ambient
	     drift logic). They're real content (kept in the DOM for crawlers and assistive
	     tech), presented as an ambient starfield; only their opacity/position animate. -->
	<ul class="stats" aria-label={m.landing_actions_aria()}>
		{#each figures as figure, i (figure.key)}
			<li
				class="stat"
				class:stat--visible={floats[i]?.visible}
				style={slotStyle(floats[i]?.slot ?? 0)}
			>
				<span class="stat__value">{stats ? fmt(figure.value) : '—'}</span>
				<span class="stat__label">{figure.label}</span>
			</li>
		{/each}
	</ul>

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

	/* The landing floats over deep space (and, where it grazes the globe's top edge,
	   over lit tiles). A dark drop plus a faint cool glow keeps the light text crisp on
	   the near-black backdrop and still legible if it overlaps the globe. */
	.intro__brand,
	.intro__title {
		text-shadow:
			0 1px 3px rgba(0, 0, 0, 0.7),
			0 0 18px rgba(10, 14, 30, 0.6);
	}

	.intro__brand {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 650;
		letter-spacing: 0.01em;
		/* Brightened accent so the green reads against the dark space backdrop. */
		color: #7cc79f;
	}

	.intro__title {
		margin: 0;
		font-size: clamp(1.5rem, 3.5vw, 2.2rem);
		line-height: 1.15;
		color: #f3f6fc;
	}

	/* The coverage figures drift through the dark space around the globe: each is
	   absolutely placed at its current edge slot (set inline) and fades its opacity in
	   and out. The <ul> itself is just a non-interactive positioning context. */
	.stats {
		list-style: none;
		margin: 0;
		padding: 0;
		pointer-events: none;
	}

	.stat {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		/* Light text tuned for the deep-space backdrop, with a cool glow plus a dark
		   drop so it also holds up if a slot grazes the lit globe edge. */
		color: #eef2ff;
		text-shadow:
			0 0 14px rgba(120, 150, 255, 0.55),
			0 1px 3px rgba(0, 0, 0, 0.65);
		opacity: 0;
		transition: opacity 1100ms ease;
	}

	.stat--visible {
		opacity: 1;
	}

	.stat__value {
		font-size: clamp(1.3rem, 4vw, 1.9rem);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}

	.stat__label {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: rgba(205, 214, 245, 0.8);
	}

	/* Reduced-motion users get the figures pinned and steady (JS keeps them visible);
	   kill the opacity transition so there's no fade at all. */
	@media (prefers-reduced-motion: reduce) {
		.stat {
			transition: none;
		}
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
