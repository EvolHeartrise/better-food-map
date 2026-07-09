<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Spring, prefersReducedMotion } from 'svelte/motion';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { PLACES_PATH } from '$lib/browse';
	import {
		getCameraAxis,
		getGlobeScreen,
		projectSpaceVector,
		cross,
		normalize,
		type Vec3
	} from '$lib/globe-space';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	// Coverage totals shown on the zoomed-out landing. Structural (not imported from
	// the server db module) so the overlay carries no server-only import — mirroring
	// how LocationMap keeps its own prop types.
	type Stats = {
		locations: number;
		items: number;
		cities: number;
		// Per-dietary-tag dish counts (see getStats), keyed by dietary tag id.
		diets: Record<string, number>;
	};

	let {
		stats,
		map,
		onstart
	}: {
		// Null until the counts resolve; the figures hold at "—" until then.
		stats: Stats | null;
		// The live MapLibre instance (null until it loads), used to project the coverage
		// figures into the 3D space around the globe. Null → the figures stay hidden.
		map: MapLibreMap | null;
		// "Start using": fly the map to the visitor's location. The parent owns the fly.
		onstart: () => void;
	} = $props();

	// Built from the active per-page locale (fixed per page load), so coverage
	// counts group digits the reader's way (en `1,234` vs fr `1 234`).
	const numberFormat = new Intl.NumberFormat(getLocale());
	function fmt(value: number): string {
		return numberFormat.format(Math.round(value));
	}

	// Every coverage figure that can orbit, in the order they're assigned to SEATS
	// below: its stable {#each} identity (`key`, locale-independent), how to pull its
	// count out of the stats payload (`value`), and its localized label (a message
	// getter, called per render so a locale change re-resolves it). The three coverage
	// totals lead; the six dietary dish counts follow (each the count the diet selector
	// would surface — see getStats). SEATS must stay the same length as this list.
	const STAT_DEFS: { key: string; value: (s: Stats) => number; label: () => string }[] = [
		{ key: 'venues', value: (s) => s.locations, label: m.stat_venues },
		{ key: 'items', value: (s) => s.items, label: m.stat_menu_items },
		{ key: 'cities', value: (s) => s.cities, label: m.stat_cities },
		{ key: 'vegetarian', value: (s) => s.diets.vegetarian ?? 0, label: m.stat_vegetarian },
		{ key: 'vegan', value: (s) => s.diets.vegan ?? 0, label: m.stat_vegan },
		{ key: 'halal', value: (s) => s.diets.halal ?? 0, label: m.stat_halal },
		{ key: 'gluten_free', value: (s) => s.diets.gluten_free ?? 0, label: m.stat_gluten_free },
		{ key: 'dairy_free', value: (s) => s.diets.dairy_free ?? 0, label: m.stat_dairy_free },
		{ key: 'nut_free', value: (s) => s.diets.nut_free ?? 0, label: m.stat_nut_free }
	];

	// Count the figures up from zero. The overlay is mounted afresh whenever the landing
	// appears (the parent's `{#if landing}`), so the spring starts at 0 every time and
	// springs up to the totals — re-running the count-up on each appearance. `damping: 1`
	// keeps it from overshooting (a count that flies past then settles reads as a glitch);
	// reduced-motion users get the final numbers instantly. Keyed by STAT_DEFS `key`.
	const zeros = (): Record<string, number> => Object.fromEntries(STAT_DEFS.map((d) => [d.key, 0]));
	const counts = new Spring(zeros(), { stiffness: 0.08, damping: 1 });
	$effect(() => {
		if (!stats) return;
		const target = Object.fromEntries(STAT_DEFS.map((d) => [d.key, d.value(stats)]));
		counts.set(target, { instant: prefersReducedMotion.current });
	});

	// The figures, in display order, reading the live (animating) spring values.
	const figures = $derived(
		STAT_DEFS.map((d) => ({ key: d.key, value: counts.current[d.key] ?? 0, label: d.label() }))
	);

	// --- Coverage figures floating in the 3D space around the globe -----------
	// Each figure hangs at a point out in the void around the globe: a geographic
	// direction (frozen once, on the first frame, from a nicely-spread screen bearing)
	// pushed out to `radius` > 1 so it sits off the globe's disc, in space. Every frame
	// it is projected through the map's own globe camera (see $lib/globe-space) for real
	// perspective and parallax — and, because the anchor is geographic (pinned to the
	// globe, not the screen), for genuine depth: drag/rotate the globe and a figure that
	// swings round to the far side ducks BEHIND it (fading out via the projector's
	// occlusion test). A slow bob gives them a little life at rest. Positions are written
	// straight to the DOM (like the map's venue pills), so per-frame updates never wake
	// Svelte reactivity.
	//
	// SEATS place each figure out in the void as (off-axis angle from the disc centre,
	// screen bearing, radius). ~55–63° off axis sits them near the limb so `radius`
	// lifts them clear into the void; the radii are staggered so the figures sit at
	// slightly different depths (a cloud in space, not one flat ring). The two floating
	// text blocks — the title (top-centre) and the CTA (bottom-centre) — own wide boxes
	// the figures must not collide with, so the bearings fan the globe's LEFT and RIGHT
	// flanks (bearing near 0 and near ±π) across the clear mid-vertical band, staying
	// away from straight up / straight down (±π/2). Four fan down the right side,
	// five down the left. Each bearing resolves to a frozen geographic anchor once the
	// camera is known, so the figures stay pinned to the globe thereafter. Must stay
	// the same length as STAT_DEFS.
	type Seat = { angle: number; bearing: number; radius: number };
	const SEATS: Seat[] = [
		// Right flank, upper → lower
		{ angle: 1.02, bearing: 0.5, radius: 1.6 },
		{ angle: 1.06, bearing: 0.12, radius: 1.5 },
		{ angle: 1.0, bearing: -0.22, radius: 1.5 },
		{ angle: 1.05, bearing: -0.58, radius: 1.6 },
		// Left flank, upper → lower (sweeping through ±π)
		{ angle: 1.03, bearing: 2.62, radius: 1.58 },
		{ angle: 1.07, bearing: 2.92, radius: 1.48 },
		{ angle: 1.0, bearing: 3.14, radius: 1.46 },
		{ angle: 1.06, bearing: -2.96, radius: 1.5 },
		{ angle: 1.02, bearing: -2.66, radius: 1.6 }
	];
	const DEG = 180 / Math.PI;
	// Frozen geographic anchor (lng/lat, degrees) per figure — null until the first frame.
	let anchors: { lng: number; lat: number }[] | null = null;

	// The figure elements, bound per row; positioned imperatively in the frame loop, plus
	// the intro/actions blocks whose boxes the figures must stay clear of.
	const statEls: (HTMLElement | null)[] = SEATS.map(() => null);
	let introEl = $state<HTMLElement | null>(null);
	let actionsEl = $state<HTMLElement | null>(null);

	// A soft 0→1 gate: 0 when (x,y) is inside `box` grown by the figure's half-size, ramping
	// to 1 over `margin` px outside it. Keeps a figure from colliding with the intro/CTA.
	function boxClearance(
		box: DOMRect | null,
		x: number,
		y: number,
		hw: number,
		hh: number,
		margin: number
	): number {
		if (!box) return 1;
		const dx = Math.max(box.left - hw - x, x - (box.right + hw), 0);
		const dy = Math.max(box.top - hh - y, y - (box.bottom + hh), 0);
		return clamp01(Math.hypot(dx, dy) / margin);
	}

	function placeFigures(currentMap: MapLibreMap, elapsedSeconds: number, animate: boolean) {
		const axis = getCameraAxis(currentMap);
		const globe = getGlobeScreen(currentMap);
		if (!axis || !globe) {
			for (const el of statEls) if (el) el.style.opacity = '0';
			return;
		}
		// Screen-plane basis perpendicular to the camera axis. `worldUp` degenerates only
		// at the poles (camera looking straight down an axis); fall back to X there.
		const worldUp: Vec3 = Math.abs(axis[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
		const right = normalize(cross(worldUp, axis));
		const up = normalize(cross(axis, right));

		// Freeze each figure's geographic anchor once, from its screen bearing in the
		// current view — after this the anchors are pinned to the globe (so it can turn
		// under them and carry them behind), independent of the camera.
		if (!anchors) {
			anchors = SEATS.map((s) => {
				const sa = Math.sin(s.angle);
				const dir = normalize([
					axis[0] * Math.cos(s.angle) +
						sa * (Math.cos(s.bearing) * right[0] + Math.sin(s.bearing) * up[0]),
					axis[1] * Math.cos(s.angle) +
						sa * (Math.cos(s.bearing) * right[1] + Math.sin(s.bearing) * up[1]),
					axis[2] * Math.cos(s.angle) +
						sa * (Math.cos(s.bearing) * right[2] + Math.sin(s.bearing) * up[2])
				]);
				return { lat: Math.asin(dir[1]) * DEG, lng: Math.atan2(dir[0], dir[2]) * DEG };
			});
		}

		const introBox = introEl?.getBoundingClientRect() ?? null;
		const actionsBox = actionsEl?.getBoundingClientRect() ?? null;

		for (let i = 0; i < SEATS.length; i++) {
			const el = statEls[i];
			if (!el) continue;
			const seat = SEATS[i];
			const anchor = anchors[i];
			// A slow, per-figure bob around the anchor so they drift gently at rest.
			const t = animate ? elapsedSeconds : 0;
			const lngR = (anchor.lng + 2.5 * Math.sin(0.25 * t + i * 2.1)) / DEG;
			const latR = (anchor.lat + 1.8 * Math.sin(0.19 * t + i * 1.3)) / DEG;
			const radius = seat.radius + 0.05 * Math.sin(0.22 * t + i);
			const cosLat = Math.cos(latR);
			const dir: Vec3 = [Math.sin(lngR) * cosLat, Math.sin(latR), Math.cos(lngR) * cosLat];
			const p = projectSpaceVector(currentMap, dir, radius);
			if (!p) {
				el.style.opacity = '0';
				continue;
			}
			// Safety gates: fade out over the globe's disc (so a figure never reads as a
			// map label) and away from the intro/CTA (so it never collides) — the seats
			// already avoid both, so these only bite if the user turns the globe hard.
			const hw = el.offsetWidth / 2;
			const hh = el.offsetHeight / 2;
			const overGlobe = clamp01((Math.hypot(p.x - globe.cx, p.y - globe.cy) - globe.radius) / 34);
			const clear =
				overGlobe *
				boxClearance(introBox, p.x, p.y, hw, hh, 40) *
				boxClearance(actionsBox, p.x, p.y, hw, hh, 40);
			const opacity = p.visibility * clear;
			el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${p.scale})`;
			el.style.opacity = String(opacity);
			el.style.zIndex = String(Math.round(opacity * 10));
		}
	}

	function clamp01(v: number): number {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}

	// Run a frame loop while the map is available: it advances the orbits (unless the
	// user prefers reduced motion, where the figures sit still but still track the globe
	// as it's dragged) and re-projects every figure so they stay glued to the 3D scene
	// through pans, zooms and rotations. Torn down when the overlay unmounts (landing
	// dismissed) or the map goes away.
	$effect(() => {
		const currentMap = map;
		if (!currentMap) return;
		const animate = !prefersReducedMotion.current;

		let raf = 0;
		let startedAt: number | null = null;
		const frame = (now: number) => {
			if (startedAt === null) startedAt = now;
			placeFigures(currentMap, (now - startedAt) / 1000, animate);
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	});
</script>

<!-- Three floating pieces over the zoomed-out globe: an intro pinned to the top, an
     actions block pinned to the bottom, and the coverage figures orbiting through the
     3D space around the globe in between. No card chrome — just text and controls
     floating on the map. The backdrop and the non-interactive text pass pointers through
     (so a drag on the globe still pans, and zooming in dismisses the landing); only the
     button takes clicks. -->
<div class="overlay" transition:fade={{ duration: 200 }}>
	<section class="intro" aria-label={m.landing_intro_aria()} bind:this={introEl}>
		<p class="intro__brand">🍴 BetterFoodMaps</p>
		<h1 class="intro__title">{m.landing_title()}</h1>
	</section>

	<!-- The coverage figures, orbiting in the 3D space around the globe (positioned every
	     frame by the projection loop above). They're real content — kept in the DOM for
	     crawlers and assistive tech — presented as bodies drifting through space; only
	     their transform/opacity animate. -->
	<ul class="stats" aria-label={m.landing_stats_aria()}>
		{#each figures as figure, i (figure.key)}
			<li class="stat" bind:this={statEls[i]}>
				<span class="stat__value">{stats ? fmt(figure.value) : '—'}</span>
				<span class="stat__label">{figure.label}</span>
			</li>
		{/each}
	</ul>

	<section class="actions" aria-label={m.landing_actions_aria()} bind:this={actionsEl}>
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

	/* The coverage figures orbit through the dark space around the globe: each is
	   absolutely positioned and its transform/opacity are written every frame by the
	   projection loop. The <ul> is just a non-interactive positioning context. The
	   figures anchor at their own centre (the loop applies translate(-50%,-50%)). */
	.stats {
		list-style: none;
		margin: 0;
		padding: 0;
		pointer-events: none;
	}

	.stat {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		white-space: nowrap;
		/* Light text tuned for the deep-space backdrop, with a cool glow plus a dark
		   drop so it also holds up if it drifts across the lit globe edge. */
		color: #eef2ff;
		text-shadow:
			0 0 14px rgba(120, 150, 255, 0.55),
			0 1px 3px rgba(0, 0, 0, 0.65);
		/* Start hidden to avoid a flash at (0,0) before the first frame projects it. */
		opacity: 0;
		will-change: transform, opacity;
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
