<script lang="ts">
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, type Snippet } from 'svelte';
	import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
	import {
		LabelEngine,
		geoCellDegrees,
		holdZoom,
		hashId,
		type Projector,
		type RenderItem,
		type SimConfig
	} from '$lib/label-layout';

	// A geographic bounding box reported to the parent as the visible area. Kept
	// structural (rather than imported from the server module) so this component
	// stays free of any server-only import.
	type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

	// Only the fields the map actually needs. The label shows the venue name plus, on a
	// second line, a rotating display of the venue's food items (its whole menu, or just
	// the items matching an active filter) with a "+N more" count. Kept structural
	// (rather than derived from a remote's return type) so any location-shaped object can
	// be passed in.
	type Location = {
		id: string;
		name: string;
		latitude: number;
		longitude: number;
		// The food-item names this venue rotates through beneath its name. Empty when the
		// venue has no menu (then only the name shows). The first is shown initially and
		// the display cycles through the rest; "+N more" reports the count of the others.
		items: string[];
	};

	let {
		locations,
		// The currently selected location, shown zoomed-in with its detail card
		// open on the map. When set, the map flies to it once and keeps its label
		// visible even if it isn't among the in-view `locations`.
		selected = null,
		// Called with a location id when the user clicks a name label, so the parent
		// can open that location (selecting it).
		onselect,
		// The selected venue's detail card. Rendered as an overlay element the map
		// keeps positioned at the venue's projected point; the parent supplies the
		// content (and all its app state) via this snippet.
		detailCard,
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
		detailCard?: Snippet;
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
	// Declutter grid for the name pills: keep at most NAME_PER_CELL pill per cell, sizing
	// the cell so it's ≈ NAME_CELL_PX wide on screen at the current zoom. Density stays
	// UNIFORM across the screen (a dense downtown thins to the same labels-per-area as a
	// sparse suburb) and the count handed to the force sim stays bounded — and so
	// settle-able. The cell is computed in DEGREES from the zoom (geoCellDegrees) and the
	// bucketing is geographic, NOT screen-space: a venue's lng/lat doesn't move when the
	// camera pans, so its cell — and which pill wins it — is pan-invariant on the globe
	// projection as well as flat Mercator (a screen-space lattice is not, because a globe
	// pan is a sphere rotation, not a translation — that was the zoomed-out flicker). As
	// the user zooms in the cell shrinks in degrees, spreading anchors across more cells so
	// more names reveal. Larger NAME_CELL_PX = sparser map.
	const NAME_CELL_PX = 84;
	const NAME_PER_CELL = 1;
	// The cell SIZE is derived from the zoom, but MapLibre's reported zoom micro-jitters
	// (~±0.0004) during a globe pan — enough to wobble the cell and flip boundary labels in
	// and out every frame. So the cell's zoom is held steady (holdZoom) and only re-adopted
	// when the camera zoom moves at least this much — far above the jitter, below a real zoom
	// step — so a pure pan never resizes the lattice and only a deliberate zoom does.
	const CELL_ZOOM_THRESHOLD = 0.25;
	// Hard ceiling on simultaneously-drawn pills, a backstop against a pathological frame.
	// The world-anchored declutter grid is the REAL limiter and must bind first, so this
	// stays above the most labels a normal viewport yields — including a zoomed-out one,
	// where the server sends up to its result cap (200) of grid-cell representatives at once.
	// A global top-N trim isn't pan-stable (which labels survive the cut shifts as you pan),
	// so letting it bite would reintroduce the very flicker the grid exists to prevent.
	const MAX_VISIBLE = 240;
	// How often (ms) to re-pick the visible set. Positions update every frame, but
	// which labels are shown only needs refreshing a few times a second.
	const DECLUTTER_INTERVAL_MS = 120;
	// Off-screen margin (px) within which anchors still count, so a pill entering
	// from the edge is already simulated before it scrolls fully into view.
	const OVERLAY_MARGIN = 80;
	// Force-model constants (see SimConfig) for the name-pill layout: a STRONG spring that
	// holds each pill centred on its venue's coordinate, and a collision pass that
	// separates only the pills whose boxes would overlap, by the least amount needed — so
	// labels sit right on their points and merely nudge apart where they'd otherwise
	// collide. `maxLeader` caps how far a crowded pill can be pushed off its point.
	const SIM_CONFIG: SimConfig = {
		spring: 0.25,
		separation: 0.5,
		padding: 6,
		maxLeader: 120
	};

	// How often (ms) the food-item line under each venue name advances to the next item.
	// One shared interval drives every pill; a per-venue phase offset (see rotationOffset)
	// staggers WHICH item each shows so they don't all display the same position.
	const ROTATE_INTERVAL_MS = 3000;

	// Where the detail card sits relative to the selected venue's point: up and to
	// the right, clamped to the viewport (see positionDetailCard).
	const DETAIL_OFFSET_X = 16;
	const DETAIL_OFFSET_Y = 12;

	// Inflate each pill's clickable/hover box by this many px so a small pill stays a
	// comfortable tap target (the pills themselves are pointer-transparent; this is
	// the slop used by the map-level hit-test).
	const HIT_SLOP = 6;
	// The rAF loop parks itself once the camera is still and every pill's per-frame
	// movement (vx²+vy², the offset change the sim records) falls below this, then a map
	// gesture or data change wakes it — so an idle map does no per-frame work. ~0.04
	// px/frame: visually at rest.
	const SETTLE_KE_EPS = 0.0016;
	// Even with the density grid, a momentarily over-packed area can have no overlap-free
	// rest state — the sim would then jostle forever and the loop never park. So once the
	// camera is still, the sim gets this many frames (~4 s at 60fps) to settle; past it
	// the loop parks anyway, accepting the current near-rest layout. Any camera move or
	// data/selection change resets the budget (see `wake`).
	const SIM_MAX_SETTLE_FRAMES = 240;

	let mapEl: HTMLDivElement;
	// The overlay element wrapping the detail-card snippet; the frame loop writes its
	// transform to keep it pinned to the selected venue's point.
	let detailCardEl = $state<HTMLDivElement | undefined>();

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

	// Bumped by a shared interval to advance every pill's rotating food-item line. It's
	// plain reactive state read in the template, NOT fed to the force sim — the rotating
	// text changes within a fixed-size box (the item name ellipsizes), so a tick rewrites
	// text without moving or re-measuring any pill, and the layout loop stays parked.
	let rotateTick = $state(0);

	// Becomes true once the map's first render is done; effects below gate on it so
	// they don't fire against a half-built map (the import + style load are async).
	let ready = $state(false);

	// rAF + overlay bookkeeping.
	let rafId = 0;
	// Whether the rAF loop is currently scheduled. It parks when idle+settled and is
	// restarted by `wake()` on any camera move/resize or data/selection change.
	let running = false;
	// Consecutive still-camera frames the sim has run without settling; the loop gives
	// up and parks past SIM_MAX_SETTLE_FRAMES. Reset by `wake` (any move/data change).
	let settleFrames = 0;
	let lastDeclutter = 0;
	// The overlay's CSS size, tracked from the map container so the layout knows which
	// labels are on screen and the detail card can be clamped to it.
	let overlayWidth = 0;
	let overlayHeight = 0;

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

	// Venue id → the food-item names that venue's label rotates through. Read reactively
	// in the pill template (keyed by id), so a filter change that swaps a venue's list
	// from its whole menu to just the matches updates the rotating line WITHOUT touching
	// the visible set or the force layout. Includes the selected venue even when it's not
	// among `locations` (opened from a link, or panned off screen).
	const itemsById = $derived.by(() => {
		const entries: [string, string[]][] = locations.map((l) => [l.id, l.items]);
		if (selected) entries.push([selected.id, selected.items]);
		return new Map(entries);
	});

	// A stable per-venue phase for the rotating item line, so co-visible venues don't all
	// display the same menu position in lockstep as the shared tick advances.
	function rotationOffset(id: string): number {
		return Math.floor(hashId(id) * 997);
	}

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

	// Svelte attachment factory: bind a pill's DOM element to its engine node, measure it
	// once, and place it at its current position to avoid a flash at (0,0) before the
	// first frame. The measured size is the full two-line pill (name + rotating item line);
	// the item name ellipsizes within a fixed box, so the size stays constant as the line
	// rotates. Cleanup detaches the element on unmount.
	function pillAttach(eng: LabelEngine) {
		return (id: string) => (el: HTMLElement) => {
			eng.attach(id, el, el.offsetWidth / 2 || 1, el.offsetHeight / 2 || 1);
			const node = eng.get(id);
			if (node) {
				el.style.transform = `translate(${node.ax + node.ox}px, ${node.ay + node.oy}px) translate(-50%, -50%)`;
			}
			return () => eng.detach(id, el);
		};
	}
	const pill = pillAttach(engine);

	// The zoom the declutter cell size is currently pinned to. Held steady through the
	// per-frame zoom jitter of a globe pan (see CELL_ZOOM_THRESHOLD / holdZoom) so the
	// lattice doesn't resize and flip boundary labels while panning.
	let cellZoom = 0;

	// Re-pick the visible labels for the current camera and reassign `render` — and
	// thus touch the DOM — only when the set or selection actually changed, so a
	// steady pan doesn't remount the same pills every interval.
	function recomputeVisible(project: Projector, zoom: number) {
		// Pin the cell size to a jitter-held zoom: a pure pan (zoom wobbling within the
		// threshold) keeps the same cell, so the lattice and the surviving labels stay put;
		// only a deliberate zoom past the threshold resizes it.
		cellZoom = holdZoom(cellZoom, zoom, CELL_ZOOM_THRESHOLD);
		const next = engine.recompute({
			candidates,
			project,
			width: overlayWidth,
			height: overlayHeight,
			margin: OVERLAY_MARGIN,
			selectedId: selected?.id ?? null,
			cellDeg: geoCellDegrees(cellZoom, NAME_CELL_PX),
			perCell: NAME_PER_CELL,
			max: MAX_VISIBLE
		});
		const sig = next.map((i) => (i.selected ? '*' : '') + i.id).join(',');
		if (sig !== renderSig) {
			renderSig = sig;
			render = next;
		}
	}

	// Track the overlay's CSS size from the map container. Cheap no-op when unchanged.
	function measureOverlay() {
		overlayWidth = mapEl.clientWidth;
		overlayHeight = mapEl.clientHeight;
	}

	// Write each active pill's transform to place it at its anchor + offset, returning the
	// largest per-pill movement (vx²+vy²) so the caller can tell whether the layout has
	// settled (the sim records each pill's last-frame movement into vx/vy).
	function writeTransforms(active: ReturnType<LabelEngine['tick']>): number {
		let maxMovement = 0;
		for (const node of active) {
			if (node.el) {
				const x = node.ax + node.ox;
				const y = node.ay + node.oy;
				node.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
			}
			const movement = node.vx * node.vx + node.vy * node.vy;
			if (movement > maxMovement) maxMovement = movement;
		}
		return maxMovement;
	}

	// Keep the detail card pinned to the selected venue's projected point (the stable
	// geographic anchor, not the jittering name pill), offset up-and-right and clamped
	// to stay on screen. A no-op when nothing is selected or the card isn't mounted.
	function positionDetailCard(project: Projector) {
		const el = detailCardEl;
		if (!el || !selected) return;
		const p = project(selected.longitude, selected.latitude);
		const cw = el.offsetWidth;
		const ch = el.offsetHeight;
		const margin = 10;
		let left = p.x + DETAIL_OFFSET_X;
		let top = p.y - ch - DETAIL_OFFSET_Y;
		left = Math.max(margin, Math.min(left, overlayWidth - cw - margin));
		top = Math.max(margin, Math.min(top, overlayHeight - ch - margin));
		el.style.transform = `translate(${left}px, ${top}px)`;
	}

	// Start (or restart) the rAF loop if it isn't already running. Called on load and
	// whenever something that needs re-laying-out happens — a camera move/resize or a
	// data/selection change — so the loop only spins while there's work to do.
	function wake() {
		// Any wake — a camera move/resize or a data/selection change — grants the sim a
		// fresh settle budget, so the backstop only fires after a genuinely still stretch.
		settleFrames = 0;
		if (running || !ready || !map) return;
		running = true;
		rafId = requestAnimationFrame(frame);
	}

	// One animation frame: refresh anchors from the live projection, advance the
	// force model, write each pill's transform, and keep the detail card on its venue.
	// The loop keeps going only while the camera is moving or the pills are still
	// settling; once everything is at rest it parks itself (see `wake`), so an idle map
	// costs nothing per frame.
	function frame(time: number) {
		const m = map;
		if (!m) {
			running = false;
			return;
		}

		measureOverlay();

		// Keep animating while the camera itself is in motion (pan/zoom/fly), even if
		// the pills are at rest — they must track their anchors every frame. The sim's
		// own motion is tracked separately so the settle backstop can tell "the camera
		// is moving" (must keep going) from "the sim won't settle" (give it a budget).
		const cameraMoving = m.isMoving();
		let simMoving = false;

		if (m.getZoom() < MIN_OVERLAY_ZOOM) {
			// Below the overlay floor, show nothing.
			if (render.length) {
				render = [];
				renderSig = '';
				engine.clear();
			}
		} else {
			// A projector bound to the live camera (`m` is the narrowed, non-null map).
			const project: Projector = (lng, lat) => m.project([lng, lat]);

			if (time - lastDeclutter > DECLUTTER_INTERVAL_MS) {
				lastDeclutter = time;
				recomputeVisible(project, m.getZoom());
			}

			// Re-project the name-pill anchors and advance the force model one step (each
			// pill springs to its venue point and is pushed off any overlapping neighbour).
			const names = engine.tick(project, SIM_CONFIG);
			// Write each pill's transform; keep going while any is still moving enough to see.
			if (writeTransforms(names) > SETTLE_KE_EPS) simMoving = true;

			positionDetailCard(project);
		}

		// Settle backstop: count consecutive frames the camera is still but the sim is
		// not at rest; once that exceeds the budget, stop driving the loop even though
		// the pills are still nudging — a frustrated cluster can't spin the CPU forever.
		// While the camera moves the budget resets (the loop must keep tracking anchors).
		if (cameraMoving) settleFrames = 0;
		else if (simMoving) settleFrames++;
		const exhausted = simMoving && !cameraMoving && settleFrames > SIM_MAX_SETTLE_FRAMES;

		if ((cameraMoving || simMoving) && !exhausted) {
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

		// Advance every pill's rotating food-item line on one shared timer. This only
		// rewrites text inside a fixed-size box, so it never wakes the layout loop.
		const rotateTimer = setInterval(() => (rotateTick += 1), ROTATE_INTERVAL_MS);

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
			// that overlays the full-screen map. No compass: rotation isn't part of the
			// interaction, matching the old map.
			map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-left');

			// The pills are pointer-transparent so wheel-zoom, drag-pan and pinch pass
			// straight through to the map even when the cursor is over one. That means
			// selection and the hover cursor can't come from DOM events on the pills, so we
			// resolve them here by hit-testing the click/hover point against the pill boxes
			// the engine is laying out. A tap anywhere on a venue's label — its name or the
			// rotating food-item line beneath it — selects that venue.
			map.on('click', (e) => {
				const id = engine.hitTest(e.point.x, e.point.y, HIT_SLOP);
				if (id) onselect?.(id);
			});
			map.on('mousemove', (e) => {
				const m = map;
				if (!m) return;
				const hit = engine.hitTest(e.point.x, e.point.y, HIT_SLOP);
				m.getCanvas().style.cursor = hit ? 'pointer' : '';
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
				measureOverlay();
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
			clearInterval(rotateTimer);
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

	// Place the detail card the moment it mounts (or the selection changes), so it
	// doesn't flash at (0,0) for a frame before the loop repositions it.
	$effect(() => {
		const m = map;
		if (!ready || !m || !detailCardEl || !selected) return;
		positionDetailCard((lng, lat) => m.project([lng, lat]));
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
	<!-- Pills are presentational: pointer-transparent so map gestures pass through, with
	     click-to-select handled by the map's hit-test (see onMount). Each pill shows the
	     venue name and, beneath it, a rotating food-item line. The venue names are also
	     reachable via search, the accessible path. -->
	<div class="labels" aria-hidden="true">
		{#each render as item (item.id)}
			{@const names = itemsById.get(item.id) ?? []}
			{@const current =
				names.length > 0 ? names[(rotateTick + rotationOffset(item.id)) % names.length] : null}
			<div
				class="pill"
				class:pill--selected={item.selected}
				class:pill--has-item={current !== null}
				{@attach pill(item.id)}
			>
				<span class="pill__name">{item.name}</span>
				<!-- The rotating food-item line: the current item (ellipsized within a fixed
				     box so the pill never resizes as it cycles) and a "+N more" count of the
				     others. Absent when the venue has no items to show. -->
				{#if current !== null}
					<span class="pill__sub">
						{#key current}
							<span class="pill__item">{current}</span>
						{/key}
						{#if names.length > 1}
							<span class="pill__more">+{names.length - 1} more</span>
						{/if}
					</span>
				{/if}
			</div>
		{/each}
	</div>

	<!-- The selected venue's detail card, kept positioned at its point by the frame
	     loop. Sits outside `.labels` so it isn't clipped, and opts back into pointer
	     events so its links/buttons work. -->
	{#if selected && detailCard}
		<div class="detail-card" bind:this={detailCardEl}>
			{@render detailCard()}
		</div>
	{/if}
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

	/* The pills overlay the map. The pill container never intercepts pointer events (so
	   panning works everywhere); the pills are pointer-transparent too, so a click is
	   hit-tested on the map and never blocks a drag on the surrounding map. */
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
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 3px 9px;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 12px;
		background: #ffffff;
		color: #000000;
		font-size: 12px;
		line-height: 1.25;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
		user-select: none;
		will-change: transform;
	}

	/* A pill that carries a rotating food-item line gets a comfortable minimum width so
	   the line stays legible (and the "+N more" count has room) even under a short venue
	   name. The width is then fixed for that pill, so the rotating item — which ellipsizes
	   within it — never resizes the pill or perturbs the force layout as it cycles. */
	.pill--has-item {
		min-width: 8rem;
		max-width: 15rem;
	}

	.pill__name {
		white-space: nowrap;
		font-weight: 500;
	}

	/* The second line: the rotating item name (flexes and ellipsizes) followed by the
	   "+N more" count pinned to the right. */
	.pill__sub {
		display: flex;
		align-items: baseline;
		gap: 0.45em;
		margin-top: 1px;
		font-size: 11px;
	}

	.pill__item {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: #2f6f4f;
		/* A quick fade as each item swaps in (the element is re-keyed per rotation). */
		animation: pill-item-in 0.35s ease;
	}

	.pill__more {
		flex: none;
		margin-left: auto;
		color: rgba(0, 0, 0, 0.45);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	@keyframes pill-item-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* Mark the selected venue's pill in the app accent; its rotating line inverts to stay
	   legible on the accent fill. */
	.pill--selected {
		background: #2f6f4f;
		border-color: #2f6f4f;
		color: #ffffff;
	}

	.pill--selected .pill__name {
		font-weight: 600;
	}

	.pill--selected .pill__item {
		color: rgba(255, 255, 255, 0.92);
	}

	.pill--selected .pill__more {
		color: rgba(255, 255, 255, 0.7);
	}

	/* The selected venue's detail card. The wrapper only positions it (the frame loop
	   writes its transform) and re-enables pointer events; its surface styling is
	   supplied by the page through the snippet. */
	.detail-card {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 3;
		pointer-events: auto;
		will-change: transform;
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
