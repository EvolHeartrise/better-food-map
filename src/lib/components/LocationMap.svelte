<script lang="ts">
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';
	import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
	import { LabelEngine, type Projector, type RenderItem, type SimConfig } from '$lib/label-layout';

	// A geographic bounding box reported to the parent as the visible area. Kept
	// structural (rather than imported from the server module) so this component
	// stays free of any server-only import.
	type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

	// Only the fields the map actually needs (the labels show just the name, so no
	// category/address). Kept structural (rather than derived from a remote's return
	// type) so any location-shaped object can be passed in.
	type Location = {
		id: string;
		name: string;
		latitude: number;
		longitude: number;
	};

	let {
		locations,
		// The currently selected location, shown zoomed-in with its detail panel
		// open on the page. When set, the map flies to it once and keeps its label
		// visible even if it isn't among the in-view `locations`.
		selected = null,
		// Called with a location id when the user clicks a name label, so the parent
		// can open that location (the same action as clicking a result card).
		onselect,
		// Where the map opens, as `[lat, lng]`. Falls back to DEFAULT_CENTER when absent.
		// The camera otherwise only moves when the user pans/zooms or selects a place —
		// search/filter changes never move it.
		initialCenter = null,
		// Zoom the map opens at. Defaults to a city view (DEFAULT_ZOOM); the landing
		// passes a low value so the map opens on the fully zoomed-out globe.
		initialZoom = null,
		// Called with the current zoom whenever it changes (live, during the gesture),
		// plus once on load. The landing uses this to drive itself: it shows while the
		// map is zoomed out and hides once the user zooms in (and returns on zoom-out).
		onzoom,
		// A point to fly the camera to (without selecting it) — used by global search
		// to bring the nearest match into view. The camera flies whenever `key`
		// changes, so the parent controls exactly when a fly happens (it omits it when
		// the target is already on screen). Null leaves the camera untouched.
		focus = null,
		// Called (debounced) with the visible bounding box whenever the map settles
		// after a pan/zoom, plus once on load. The parent fetches location data for
		// this box, so only what's on screen is ever loaded.
		onviewchange
	}: {
		locations: Location[];
		selected?: Location | null;
		onselect?: (id: string) => void;
		initialCenter?: [number, number] | null;
		initialZoom?: number | null;
		onzoom?: (zoom: number) => void;
		focus?: { latitude: number; longitude: number; key: string } | null;
		onviewchange?: (bounds: Bounds) => void;
	} = $props();

	// Fallback map center, used when no `initialCenter` is supplied (e.g. IP
	// geolocation is unavailable) — just a sensible starting view, not tied to any
	// particular city. Stored `[lat, lng]` to match the prop contract; converted to
	// MapLibre's `[lng, lat]` order at the call sites via `toLngLat`.
	const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];
	// MapLibre's camera zoom runs one level "lower" than Leaflet's for the same
	// scale (its world base is a 512px tile vs Leaflet's 256px), so these are the
	// old Leaflet values minus one: DEFAULT 13→12, SELECTED 16→15.
	const DEFAULT_ZOOM = 12;
	// Zoom level used when flying to a single selected location.
	const SELECTED_ZOOM = 15;
	// Minimum zoom when flying to a search's nearest match: if the user is already
	// zoomed further in we keep their zoom (just recenter), but from a zoomed-out
	// globe we pull in to at least a city view so the match is legible on arrival.
	const FOCUS_MIN_ZOOM = 12;
	// Fly animation duration when centering on a selected location (milliseconds —
	// MapLibre takes ms, where Leaflet took seconds).
	const FLY_DURATION_MS = 600;
	// OpenStreetMap's raster tiles stop at z19; cap the camera there so the user
	// can't zoom past real tile data into blurry overzoomed scaling.
	const MAX_ZOOM = 19;
	// Grow the reported box beyond the strictly-visible bounds by this fraction of
	// each span, so labels just off screen are already loaded when the user nudges
	// the map, and small pans don't trigger a refetch. 0.2 = 20% on every side.
	const BOUNDS_PADDING = 0.2;
	// Debounce (ms) before reporting a new viewport, so a drag or pinch settles into
	// a single fetch rather than firing on every intermediate `moveend`.
	const VIEW_DEBOUNCE_MS = 250;

	// --- Label overlay tuning -------------------------------------------------
	// Below this zoom the map is curved enough (and the world dense enough) that
	// names aren't worth drawing — the overlay renders nothing and the globe stays
	// clean. Above it the declutter gap does the progressive reveal.
	const MIN_OVERLAY_ZOOM = 6;
	// Minimum on-screen spacing (px) between two surviving anchors. Anything packed
	// tighter than this loses to its higher-priority neighbour and is hidden until
	// zoom spreads the anchors apart. Larger = sparser map.
	const DECLUTTER_GAP = 42;
	// Hard ceiling on simultaneously-drawn pills, a backstop against a pathological
	// frame; the declutter gap is the real limiter well before this bites.
	const MAX_VISIBLE = 160;
	// How often (ms) to re-pick the visible set. Positions update every frame, but
	// which labels are shown only needs refreshing a few times a second.
	const DECLUTTER_INTERVAL_MS = 120;
	// Off-screen margin (px) within which anchors still count, so a pill entering
	// from the edge is already simulated before it scrolls fully into view.
	const OVERLAY_MARGIN = 80;
	// Force-model constants (see SimConfig). Tuned for a calm, quick settle.
	const SIM_CONFIG: SimConfig = {
		spring: 0.08,
		damping: 0.75,
		separation: 0.6,
		padding: 6,
		maxLeader: 64
	};
	// Don't draw a leader line until the pill has been displaced at least this far
	// (px) from its origin — an on-origin pill needs no line.
	const LEADER_MIN_DISTANCE = 4;
	// Leader-line stroke.
	const LEADER_COLOR = 'rgba(0, 0, 0, 0.35)';
	// Inflate each pill's clickable/hover box by this many px so a small pill stays a
	// comfortable tap target (the pills themselves are pointer-transparent; this is
	// the slop used by the map-level hit-test).
	const HIT_SLOP = 6;
	// The rAF loop parks itself once the camera is still and every pill's kinetic
	// energy (vx²+vy²) falls below this, then a map gesture or data change wakes it —
	// so an idle map does no per-frame work. ~0.04 px/frame: visually at rest.
	const SETTLE_KE_EPS = 0.0016;

	let mapEl: HTMLDivElement;
	let canvasEl: HTMLCanvasElement;

	// MapLibre's JS is imported dynamically inside onMount (client-only) because it
	// touches `window` at module load; the types are erased at compile time so
	// importing them is fine. `lib` holds the module namespace once loaded.
	let lib: typeof import('maplibre-gl') | null = null;
	let map: MapLibreMap | null = null;

	// Owns the persistent per-pill simulation state across frames (positions survive
	// a re-render and brief visibility toggles). Plain — and deliberately
	// non-reactive — Map/Set state lives inside the engine, not this component.
	const engine = new LabelEngine();

	// The pills currently mounted in the DOM. Reactive so the {#each} tracks it, but
	// reassigned only when the visible set/selection actually changes (guarded by
	// `renderSig`), so panning that keeps the same labels does no DOM work.
	let render = $state<RenderItem[]>([]);
	let renderSig = '';

	// Becomes true once the map's first render is done; effects below gate on it so
	// they don't fire against a half-built map (the import + style load are async).
	let ready = $state(false);

	// rAF + canvas bookkeeping.
	let rafId = 0;
	// Whether the rAF loop is currently scheduled. It parks when idle+settled and is
	// restarted by `wake()` on any camera move/resize or data/selection change.
	let running = false;
	let lastDeclutter = 0;
	let canvasCtx: CanvasRenderingContext2D | null = null;
	let canvasCssWidth = 0;
	let canvasCssHeight = 0;
	// Last device-pixel-ratio the canvas backing store was sized for, so a move to a
	// different-DPR display (even at the same CSS size) re-sharpens the leader lines.
	let lastDpr = 0;

	// Pending debounced viewport report (see scheduleViewReport).
	let viewTimer: ReturnType<typeof setTimeout> | null = null;
	// The last selected id we flew to, so re-renders (e.g. a viewport refetch) don't
	// re-fly to an already-open location — only a genuine change of selection does.
	let lastSelectedId: string | null = null;
	// The last focus key we flew to, so the focus effect fires once per new target
	// (a data re-sync or the parent re-passing the same focus won't re-fly).
	let lastFocusKey: string | null = null;

	// The label candidates: every in-view location, plus the selected one even when
	// it falls outside the viewport (e.g. opened from a shared link). Flattened to
	// just what the overlay needs.
	const candidates = $derived.by(() => {
		const list = locations.map((l) => ({
			id: l.id,
			name: l.name,
			lat: l.latitude,
			lng: l.longitude
		}));
		if (selected && !list.some((c) => c.id === selected.id)) {
			list.push({
				id: selected.id,
				name: selected.name,
				lat: selected.latitude,
				lng: selected.longitude
			});
		}
		return list;
	});

	// The prop contract carries centres as `[lat, lng]` (Leaflet's order, and how
	// the page supplies the IP-detected centre); MapLibre wants `[lng, lat]`.
	function toLngLat([lat, lng]: [number, number]): [number, number] {
		return [lng, lat];
	}

	// The map style: OpenStreetMap raster tiles on a 3D globe projection. MapLibre
	// renders this flat (Web Mercator) when zoomed in and smoothly curves it into a
	// globe as the user zooms out, with no work on our part. The `sky` atmosphere
	// gives the zoomed-out globe its halo and fades out by the time the map has
	// flattened (≈ zoom 7), so it never intrudes on the street-level view. No
	// `glyphs`: the name labels are HTML pills drawn in the overlay below, not GL
	// text, so the raster style needs no fonts.
	function mapStyle(): StyleSpecification {
		return {
			version: 8,
			projection: { type: 'globe' },
			sources: {
				osm: {
					type: 'raster',
					tiles: [
						'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
						'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
						'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
					],
					tileSize: 256,
					minzoom: 0,
					maxzoom: MAX_ZOOM,
					// OSM's tile policy / ODbL require this attribution; MapLibre surfaces
					// it in the attribution control automatically.
					attribution:
						'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
				}
			},
			layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
			sky: {
				'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
			}
		};
	}

	// Svelte attachment: bind a pill's DOM element to its engine node, measure it
	// once, and place it at its current position to avoid a flash at (0,0) before
	// the first frame. Cleanup detaches the element on unmount.
	function pill(id: string) {
		return (el: HTMLElement) => {
			engine.attach(id, el, el.offsetWidth / 2 || 1, el.offsetHeight / 2 || 1);
			const node = engine.get(id);
			if (node) {
				el.style.transform = `translate(${node.ax + node.ox}px, ${node.ay + node.oy}px) translate(-50%, -50%)`;
			}
			return () => engine.detach(id, el);
		};
	}

	// Re-pick the visible labels for the current camera and reassign `render` — and
	// thus touch the DOM — only when the set or selection actually changed, so a
	// steady pan doesn't remount the same pills every interval.
	function recomputeVisible(project: Projector) {
		const next = engine.recompute({
			candidates,
			project,
			width: canvasCssWidth,
			height: canvasCssHeight,
			margin: OVERLAY_MARGIN,
			selectedId: selected?.id ?? null,
			gap: DECLUTTER_GAP,
			max: MAX_VISIBLE
		});
		const sig = next.map((i) => (i.selected ? '*' : '') + i.id).join(',');
		if (sig !== renderSig) {
			renderSig = sig;
			render = next;
		}
	}

	// Match the leader canvas's backing store to its CSS size and the device pixel
	// ratio, so lines stay crisp. Cheap no-op when the size is unchanged.
	function resizeCanvasIfNeeded() {
		const w = mapEl.clientWidth;
		const h = mapEl.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		if (w === canvasCssWidth && h === canvasCssHeight && dpr === lastDpr) return;
		canvasCssWidth = w;
		canvasCssHeight = h;
		lastDpr = dpr;
		canvasEl.width = Math.round(w * dpr);
		canvasEl.height = Math.round(h * dpr);
		canvasEl.style.width = `${w}px`;
		canvasEl.style.height = `${h}px`;
		const ctx = canvasEl.getContext('2d');
		if (ctx) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			canvasCtx = ctx;
		}
	}

	// Start (or restart) the rAF loop if it isn't already running. Called on load and
	// whenever something that needs re-laying-out happens — a camera move/resize or a
	// data/selection change — so the loop only spins while there's work to do.
	function wake() {
		if (running || !ready || !map) return;
		running = true;
		rafId = requestAnimationFrame(frame);
	}

	// One animation frame: refresh anchors from the live projection, advance the
	// force model, write each pill's transform, and redraw the leader lines. The loop
	// keeps going only while the camera is moving or the pills are still settling;
	// once everything is at rest it parks itself (see `wake`), so an idle map costs
	// nothing per frame rather than redrawing 60×/s forever.
	function frame(time: number) {
		const m = map;
		if (!m) {
			running = false;
			return;
		}

		resizeCanvasIfNeeded();

		// Keep animating while the camera itself is in motion (pan/zoom/fly), even if
		// the pills are at rest — they must track their anchors every frame.
		let busy = m.isMoving();

		if (m.getZoom() < MIN_OVERLAY_ZOOM) {
			// Below the overlay floor, show nothing and keep the canvas clear.
			if (render.length) {
				render = [];
				renderSig = '';
				engine.clear();
			}
			canvasCtx?.clearRect(0, 0, canvasCssWidth, canvasCssHeight);
		} else {
			// A projector bound to the live camera (`m` is the narrowed, non-null map).
			const project: Projector = (lng, lat) => m.project([lng, lat]);

			if (time - lastDeclutter > DECLUTTER_INTERVAL_MS) {
				lastDeclutter = time;
				recomputeVisible(project);
			}

			// Re-project and advance the visible pills, then draw them and their leaders.
			const active = engine.tick(project, SIM_CONFIG);

			const ctx = canvasCtx;
			if (ctx) {
				ctx.clearRect(0, 0, canvasCssWidth, canvasCssHeight);
				ctx.strokeStyle = LEADER_COLOR;
				ctx.lineWidth = 1;
				ctx.beginPath();
				let maxKineticEnergy = 0;
				for (const node of active) {
					const x = node.ax + node.ox;
					const y = node.ay + node.oy;
					if (node.ox * node.ox + node.oy * node.oy > LEADER_MIN_DISTANCE * LEADER_MIN_DISTANCE) {
						// Draw to the pill centre; the opaque pill (above the canvas) hides
						// the inner stub, so the line reads as meeting the pill's edge.
						ctx.moveTo(node.ax, node.ay);
						ctx.lineTo(x, y);
					}
					if (node.el) {
						node.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
					}
					const ke = node.vx * node.vx + node.vy * node.vy;
					if (ke > maxKineticEnergy) maxKineticEnergy = ke;
				}
				ctx.stroke();
				// Keep going while any pill is still moving enough to see.
				if (maxKineticEnergy > SETTLE_KE_EPS) busy = true;
			} else {
				// Canvas not ready yet — try again next frame.
				busy = true;
			}
		}

		if (busy) {
			rafId = requestAnimationFrame(frame);
		} else {
			running = false;
		}
	}

	// Smoothly zoom in on the selected location. Its pill is force-kept visible
	// (Infinity priority) and highlighted via the render flag.
	function flyToSelected() {
		if (!map || !selected) return;
		map.flyTo({
			center: [selected.longitude, selected.latitude],
			zoom: SELECTED_ZOOM,
			duration: FLY_DURATION_MS
		});
	}

	// The current visible box, grown by BOUNDS_PADDING. Latitude is clamped to the
	// valid range; longitude is left as-is (a box across the antimeridian isn't
	// supported — the same planar assumption used elsewhere). Reported at every zoom
	// now that the page has no fetch floor: when zoomed out onto the globe this is
	// the visible cap of the world, and the server's result cap (MAP_RESULT_LIMIT)
	// is what keeps that fetch bounded.
	function currentView(): Bounds | null {
		if (!map) return null;
		const b = map.getBounds();
		const south = b.getSouth();
		const north = b.getNorth();
		const west = b.getWest();
		const east = b.getEast();
		const padLat = (north - south) * BOUNDS_PADDING;
		const padLng = (east - west) * BOUNDS_PADDING;
		return {
			minLat: Math.max(-90, south - padLat),
			maxLat: Math.min(90, north + padLat),
			minLng: west - padLng,
			maxLng: east + padLng
		};
	}

	function reportView() {
		const view = currentView();
		if (view) onviewchange?.(view);
	}

	function scheduleViewReport() {
		if (viewTimer) clearTimeout(viewTimer);
		viewTimer = setTimeout(reportView, VIEW_DEBOUNCE_MS);
	}

	onMount(() => {
		let active = true;

		(async () => {
			lib = await import('maplibre-gl');
			if (!active) return;

			map = new lib.Map({
				container: mapEl,
				style: mapStyle(),
				center: toLngLat(initialCenter ?? DEFAULT_CENTER),
				zoom: initialZoom ?? DEFAULT_ZOOM,
				maxZoom: MAX_ZOOM,
				// The OSM credit is shown; MapLibre adds no self-attribution of its own.
				attributionControl: { compact: false }
			});

			// Zoom control sits bottom-left, clear of the floating search (top-left)
			// and results (top-right) panels that overlay the full-screen map. No
			// compass: rotation isn't part of the interaction, matching the old map.
			map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-left');

			// The name pills are pointer-transparent so wheel-zoom, drag-pan and pinch
			// pass straight through to the map even when the cursor is over one. That
			// means selection and the hover cursor can't come from DOM events on the
			// pills, so we resolve them here by hit-testing the click/hover point
			// against the pill boxes the engine is laying out.
			map.on('click', (e) => {
				const id = engine.hitTest(e.point.x, e.point.y, HIT_SLOP);
				if (id) onselect?.(id);
			});
			map.on('mousemove', (e) => {
				const m = map;
				if (!m) return;
				m.getCanvas().style.cursor = engine.hitTest(e.point.x, e.point.y, HIT_SLOP)
					? 'pointer'
					: '';
			});

			// Any camera motion or container resize wakes the (possibly parked) layout
			// loop so the pills re-project and re-settle, then it parks itself again.
			map.on('move', wake);
			map.on('resize', wake);

			// Report the viewport as it changes so the parent can load data for it.
			// `moveend` fires after both pans and zooms (and programmatic flights) settle.
			map.on('moveend', scheduleViewReport);

			// Report the zoom live (every frame of a gesture or flight) so the landing can
			// track it: it shows while zoomed out and hides as the user zooms in, then
			// returns on zoom-out — whether the zoom is a user gesture or a programmatic fly.
			map.on('zoom', () => {
				if (map) onzoom?.(map.getZoom());
			});

			// `load` fires once the style is parsed and the first frame is painted —
			// only then are the projection and the opening view worth using.
			map.on('load', () => {
				if (!active || !map) return;
				ready = true;
				resizeCanvasIfNeeded();
				wake();
				// Kick off the first load immediately (no debounce) for the opening view.
				reportView();
				onzoom?.(map.getZoom());
			});
		})();

		return () => {
			active = false;
			ready = false;
			running = false;
			if (rafId) cancelAnimationFrame(rafId);
			if (viewTimer) clearTimeout(viewTimer);
			engine.clear();
			if (map) {
				map.remove();
				map = null;
			}
		};
	});

	// Refresh the visible set promptly whenever the candidates change (a viewport
	// refetch, a filter, or a new selection), rather than waiting up to one declutter
	// interval. Resets the throttle and wakes the loop in case it had parked.
	$effect(() => {
		void candidates;
		if (!ready) return;
		lastDeclutter = 0;
		wake();
	});

	// Centre on a newly-selected location. Guarded by `lastSelectedId` so a data
	// re-sync (e.g. data refetched after the fly's own move) doesn't re-trigger it —
	// only an actual change of selection flies the camera. Wakes the loop so the new
	// pill's highlight repaints even if the camera doesn't move.
	$effect(() => {
		if (!ready) return;
		const id = selected?.id ?? null;
		if (id && id !== lastSelectedId) flyToSelected();
		lastSelectedId = id;
		wake();
	});

	// Fly to a search focus target (the nearest match) when its key changes. Keeps
	// the user's zoom if they're already closer than FOCUS_MIN_ZOOM, so a fly from a
	// street-level view doesn't jump back out. Unlike selection, this never selects
	// or highlights — it only moves the camera so the nearest result is on screen.
	$effect(() => {
		if (!ready) return;
		const f = focus;
		if (!f) {
			lastFocusKey = null;
			return;
		}
		if (f.key === lastFocusKey) return;
		lastFocusKey = f.key;
		map?.flyTo({
			center: [f.longitude, f.latitude],
			zoom: Math.max(map.getZoom(), FOCUS_MIN_ZOOM),
			duration: FLY_DURATION_MS
		});
	});
</script>

<div class="map-wrap">
	<div class="map" bind:this={mapEl} role="application" aria-label="Map of food locations"></div>
	<canvas class="leaders" bind:this={canvasEl} aria-hidden="true"></canvas>
	<!-- Pills are presentational: pointer-transparent so map gestures pass through,
	     with click-to-select handled by the map's hit-test (see onMount). The venue
	     names are also reachable in the results list, the accessible selection path. -->
	<div class="labels" aria-hidden="true">
		{#each render as item (item.id)}
			<div class="pill" class:pill--selected={item.selected} {@attach pill(item.id)}>
				{item.name}
			</div>
		{/each}
	</div>
</div>

<style>
	.map-wrap {
		position: relative;
		height: 100%;
		width: 100%;
	}

	.map {
		position: absolute;
		inset: 0;
	}

	/* The leader lines and pills overlay the map. The canvas and the pill container
	   never intercept pointer events (so panning works everywhere); only the pills
	   themselves opt back in, so a click on a name selects without blocking a drag
	   on the surrounding map. */
	.leaders {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.labels {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.pill {
		position: absolute;
		top: 0;
		left: 0;
		/* Transparent to pointer events so wheel-zoom, drag-pan and pinch reach the
		   map even with the cursor over a pill; selection is hit-tested on the map. */
		pointer-events: none;
		white-space: nowrap;
		margin: 0;
		padding: 2px 8px;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 999px;
		background: #ffffff;
		color: #000000;
		font-size: 12px;
		line-height: 1.3;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
		user-select: none;
		will-change: transform;
	}

	/* Mark the selected venue's pill in the app accent (--color-accent). */
	.pill--selected {
		background: #2f6f4f;
		border-color: #2f6f4f;
		color: #ffffff;
		font-weight: 600;
	}

	/* Keep the zoom control and attribution clear of notches and the home indicator
	   on devices that report safe-area insets (the viewport is `viewport-fit=cover`). */
	.map :global(.maplibregl-ctrl-bottom-left) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-left: env(safe-area-inset-left);
	}

	.map :global(.maplibregl-ctrl-bottom-right) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-right: env(safe-area-inset-right);
	}
</style>
