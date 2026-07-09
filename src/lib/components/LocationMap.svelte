<script lang="ts">
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, type Component } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { LngLat, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
	import {
		LabelEngine,
		geoCellDegrees,
		holdZoom,
		hashId,
		type Projector,
		type RenderItem,
		type SimConfig
	} from '$lib/label-layout';
	import { DEFAULT_MAP_CENTER } from '$lib/map-defaults';
	import { m } from '$lib/paraglide/messages';
	// The shared bounding-box shape ($lib/bounds is client-safe, so importing it
	// pulls no server code into the browser bundle), reported to the parent as the
	// visible area.
	import type { Bounds } from '$lib/bounds';

	// Only the fields the map actually needs. The label shows the venue name — with a
	// count of the venue's food items beside it (its whole menu, or just the items
	// matching an active filter) — plus, on a second line, a rotating display of those
	// items. Kept structural (rather than derived from a remote's return type) so any
	// location-shaped object can be passed in.
	type Location = {
		id: string;
		name: string;
		latitude: number;
		longitude: number;
		// Importance rank for the label declutter: when venues compete for the same
		// screen cell, the highest-score pill survives (server-derived — see
		// MapLocation.score). Ties fall back to the engine's stable hash.
		score: number;
		// The food-item names this venue rotates through beneath its name. Empty when the
		// venue has no menu (then only the name shows, with no count). Its length is the
		// "N items" count shown beside the name; the first is shown initially and the
		// display cycles through the rest.
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
		// Called when the user clicks bare map (no label under the pointer), so the
		// parent can close an open location. Fires on every bare click; the parent
		// decides whether anything is open to close.
		ondeselect,
		// The screen space the parent's detail panel covers while a location is open,
		// as pixel insets from the right/bottom edges. Turned into the selection fly's
		// destination offset (see selectionOffset): the fly centres the venue in the
		// REMAINING (visible) map area, and clearing the selection glides it back to the
		// full-viewport centre as the panel leaves. Null when nothing is open.
		detailInset = null,
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
		// A point to fly the camera to (without selecting it) — used by the landing's
		// "Start using" button to open on the visitor's city. The camera flies
		// whenever `key` changes, so the parent controls exactly when a fly happens.
		// Null leaves the camera untouched.
		focus = null,
		// Called with the visible bounding box as the camera moves — throttled while
		// a pan/zoom/flight is in progress, debounced once it settles — plus once on
		// load. The parent fetches location data for this box, so only what's on
		// (or about to be on) screen is ever loaded.
		onviewchange,
		// Called with the live MapLibre instance once it has loaded (and with null on
		// teardown). Lets an overlay project its own points through the map's camera —
		// the landing uses it to place the coverage figures in the 3D space around the
		// globe (see $lib/globe-space). Purely presentational: nothing about the map's
		// own behaviour depends on it.
		onmap
	}: {
		locations: Location[];
		selected?: Location | null;
		onselect?: (id: string) => void;
		ondeselect?: () => void;
		detailInset?: { right: number; bottom: number } | null;
		initialCenter?: [number, number] | null;
		initialZoom?: number | null;
		onzoom?: (zoom: number) => void;
		focus?: { latitude: number; longitude: number; key: string } | null;
		onviewchange?: (bounds: Bounds) => void;
		onmap?: (map: MapLibreMap | null) => void;
	} = $props();

	// Fallback map center, used when no `initialCenter` is supplied (e.g. IP
	// geolocation is unavailable): the shared Vancouver opening view from
	// $lib/map-defaults — a pure client-safe module, so importing it keeps this
	// component free of server-only code (see the Bounds note above). Stored
	// `[lat, lng]` to match the prop contract; converted to MapLibre's
	// `[lng, lat]` order at the call sites via `toLngLat`.
	const DEFAULT_CENTER = DEFAULT_MAP_CENTER;
	// Opening zoom when no `initialZoom` is passed: a city view.
	const DEFAULT_ZOOM = 12;
	// Zoom level used when flying to a single selected location.
	const SELECTED_ZOOM = 15;
	// Minimum zoom when flying to a focus target: if the user is already zoomed
	// further in we keep their zoom (just recenter), but from a zoomed-out globe
	// we pull in to at least a city view so the area is legible on arrival.
	const FOCUS_MIN_ZOOM = 12;
	// Fly animation duration when centering on a selected location, in milliseconds.
	const FLY_DURATION_MS = 600;
	// OpenStreetMap's raster tiles stop at z19; cap the camera there so the user
	// can't zoom past real tile data into blurry overzoomed scaling.
	const MAX_ZOOM = 19;
	// Grow the reported box beyond the strictly-visible bounds by this fraction of
	// each span, so labels just off screen are already loaded when the user nudges
	// the map, and small pans don't trigger a refetch. 0.2 = 20% on every side.
	const BOUNDS_PADDING = 0.2;
	// Debounce (ms) before reporting a new viewport after the camera settles, so a
	// burst of `moveend`s (e.g. wheel-zoom steps) collapses into one trailing report.
	const VIEW_DEBOUNCE_MS = 250;
	// While the camera is STILL moving, report the viewport at most this often
	// (leading-edge throttle on `move`), so data for newly exposed area starts
	// loading mid-pan and mid-zoom instead of only after the gesture settles. The
	// page's cell store and in-flight dedup make a redundant report nearly free —
	// cells already fetched or fetching are skipped — so the only cost of an
	// intermediate report is starting useful fetches sooner.
	const VIEW_THROTTLE_MS = 250;

	// --- Label overlay tuning -------------------------------------------------
	// The overlay draws at EVERY zoom — there is no display floor. Density on the
	// zoomed-out globe is already bounded twice over (the declutter cell grows to
	// ~59° at zoom 0, and the server sends at most ~200 grid-cell representatives),
	// and venues on the far side of the globe are culled by `isOccluded` below, so
	// the wide view stays clean without a zoom gate.
	// Declutter grid for the name pills: keep at most NAME_PER_CELL pill per cell, sizing
	// the cell so it's ≈ NAME_CELL_PX wide on screen at the current zoom. Density stays
	// UNIFORM across the screen (a dense downtown thins to the same labels-per-area as a
	// sparse suburb) and the count handed to the force sim stays bounded — and so
	// settle-able. On top of the grid, the engine's free-space fill re-admits cell
	// losers whose overlap the force sim can resolve (see fillFreeSpace in
	// $lib/label-layout) — so two neighbouring venues, co-located stalls included,
	// both label and merely nudge apart; MAX_VISIBLE bounds grid winners and fill
	// admissions together. The cell is computed in DEGREES from the zoom (geoCellDegrees) and the
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

	// MapLibre's JS is imported dynamically inside onMount (client-only) because it
	// touches `window` at module load; the types are erased at compile time so
	// importing them is fine. `lib` holds the module namespace once loaded.
	let lib: typeof import('maplibre-gl') | null = null;
	let map: MapLibreMap | null = null;

	// Dev-only grid-cell debug overlay. Loaded through a `DEV`-gated dynamic import (in
	// onMount) so the whole feature — component, geometry and HUD — tree-shakes out of
	// production builds. `import.meta.env.DEV` is replaced by Vite with the literal
	// `false` in a prod build (before the module graph is built), so the `import()` sits
	// in provably-dead code and no chunk is ever emitted — unlike `dev` from
	// `$app/environment`, which this bundler leaves as a runtime value, shipping an
	// orphaned (never-loaded) chunk. Bundles the component with the map instance it draws
	// on, so the markup mount reads only `$state`. See src/lib/dev/GridDebug.svelte.
	const DEV = import.meta.env.DEV;
	let gridDebug = $state<{ Comp: Component<{ map: MapLibreMap }>; map: MapLibreMap } | null>(null);

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
	// labels are on screen and the camera padding can be clamped to it.
	let overlayWidth = 0;
	let overlayHeight = 0;

	// Pending debounced viewport report (see scheduleViewReport).
	let viewTimer: ReturnType<typeof setTimeout> | null = null;
	// When the viewport was last reported (performance.now()), for the mid-gesture
	// throttle: shared by every report path so a settle report also opens a fresh
	// throttle window.
	let lastViewReport = 0;
	// The last selected id we flew to, so re-renders (e.g. a viewport refetch) don't
	// re-fly to an already-open location — only a genuine change of selection does.
	let lastSelectedId: string | null = null;
	// The screen offset (px) by which the last selection fly pushed the venue off the
	// container centre to clear the detail panel. Kept so deselecting can glide the
	// venue back to the true centre even though `detailInset` is already null by then
	// (see the selection $effect). A pixel offset is zoom/pan-independent, so this
	// stays correct even if the user panned while the panel was open.
	let lastSelectionOffset: [number, number] = [0, 0];
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
			lng: l.longitude,
			priority: l.score
		}));
		if (selected && !list.some((c) => c.id === selected.id)) {
			list.push({
				id: selected.id,
				name: selected.name,
				lat: selected.latitude,
				lng: selected.longitude,
				priority: selected.score
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

	// The prop contract carries centres as `[lat, lng]` (how the page supplies
	// the IP-detected centre); MapLibre wants `[lng, lat]`.
	function toLngLat([lat, lng]: [number, number]): [number, number] {
		return [lng, lat];
	}

	// Whether a lng/lat is hidden behind the globe for the current camera. Uses the
	// transform's own `isLocationOccluded` — the same test MapLibre applies to its
	// GL symbols — so labels vanish at exactly the limb the tiles render, instead of
	// being flat-projected onto the screen from the far side (`map.project` happily
	// projects back-of-globe points). The method is marked @internal upstream, hence
	// the defensive probe: if a future maplibre-gl drops it, labels degrade to
	// drawing everywhere (the old behavior), never to a crash. The flat Mercator
	// transform occludes nothing, so no zoom gating is needed here.
	function isOccluded(lng: number, lat: number): boolean {
		if (!map || !lib) return false;
		const t = (map as unknown as { transform?: { isLocationOccluded?: (p: LngLat) => boolean } })
			.transform;
		return t?.isLocationOccluded?.(new lib.LngLat(lng, lat)) ?? false;
	}

	// The map style: OpenStreetMap raster tiles on a 3D globe projection. MapLibre
	// renders this flat (Web Mercator) when zoomed in and smoothly curves it into a
	// globe as the user zooms out, with no work on our part. There is no `sky`, so the
	// globe has no atmospheric halo and the canvas is transparent in the gap around it
	// when zoomed out — the deep-space colour behind the globe is the `.map-wrap` CSS
	// background showing through (a GL `background` layer does NOT fill that gap in
	// globe projection). Zoomed in, the tiles fill the viewport and hide it. No
	// `glyphs`: the name labels are HTML pills drawn in the overlay below, not GL text,
	// so the raster style needs no fonts.
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
			layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
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
		// Drop back-of-globe venues BEFORE decluttering, so an occluded venue never
		// claims a declutter cell or a MAX_VISIBLE slot — and, since the engine only
		// lays out what it's given, hitTest stops matching it too.
		const next = engine.recompute({
			candidates: candidates.filter((c) => !isOccluded(c.lng, c.lat)),
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
				// The declutter pass already filters occluded venues out of the visible
				// set, but it only runs every DECLUTTER_INTERVAL_MS while a globe pan
				// carries venues across the limb continuously — this per-frame toggle
				// covers the frames in between, so a pill slides to the globe's edge and
				// disappears behind it instead of lingering flat-projected.
				node.el.style.visibility = isOccluded(node.lng, node.lat) ? 'hidden' : '';
			}
			const movement = node.vx * node.vx + node.vy * node.vy;
			if (movement > maxMovement) maxMovement = movement;
		}
		return maxMovement;
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
	// force model, and write each pill's transform.
	// The loop keeps going only while the camera is moving or the pills are still
	// settling; once everything is at rest it parks itself (see `wake`), so an idle map
	// costs nothing per frame.
	function frame(time: number) {
		const mp = map;
		if (!mp) {
			running = false;
			return;
		}

		measureOverlay();

		// Keep animating while the camera itself is in motion (pan/zoom/fly), even if
		// the pills are at rest — they must track their anchors every frame. The sim's
		// own motion is tracked separately so the settle backstop can tell "the camera
		// is moving" (must keep going) from "the sim won't settle" (give it a budget).
		const cameraMoving = mp.isMoving();
		let simMoving = false;

		// A projector bound to the live camera (`mp` is the narrowed, non-null map).
		const project: Projector = (lng, lat) => mp.project([lng, lat]);

		if (time - lastDeclutter > DECLUTTER_INTERVAL_MS) {
			lastDeclutter = time;
			recomputeVisible(project, mp.getZoom());
		}

		// Re-project the name-pill anchors and advance the force model one step (each
		// pill springs to its venue point and is pushed off any overlapping neighbour).
		const names = engine.tick(project, SIM_CONFIG);
		// Write each pill's transform; keep going while any is still moving enough to see.
		if (writeTransforms(names) > SETTLE_KE_EPS) simMoving = true;

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

	// The screen offset (px) that pushes a selected venue off the container centre so
	// it sits in the middle of the map area the detail panel leaves visible: half the
	// right inset to the left, half the bottom inset up. Clamped so a panel covering
	// most of a small screen can't push the venue off the usable viewport entirely.
	// Used as the fly's destination `offset` (see flyToSelected).
	function selectionOffset(): [number, number] {
		const right = Math.min(detailInset?.right ?? 0, overlayWidth * 0.7);
		const bottom = Math.min(detailInset?.bottom ?? 0, overlayHeight * 0.7);
		return [-right / 2, -bottom / 2];
	}

	// Smoothly zoom in on the selected location, centred within the map area the
	// detail panel leaves visible. The offset is baked into the flight's destination
	// up front, so the camera flies straight to the final framing. (We deliberately do
	// NOT pass `padding` here: MapLibre interpolates padding across a flight, so a
	// padding that grows from 0 to the panel inset slides the optical centre sideways
	// as the camera arrives — the venue appears to fly to one point and then drift to
	// another. A destination `offset` lands cleanly in one motion instead.) The pill is
	// force-kept visible (Infinity priority) and highlighted via the render flag.
	function flyToSelected() {
		if (!map || !selected) return;
		const offset = selectionOffset();
		lastSelectionOffset = offset;
		map.flyTo({
			center: [selected.longitude, selected.latitude],
			zoom: SELECTED_ZOOM,
			offset,
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
		lastViewReport = performance.now();
		const view = currentView();
		if (view) onviewchange?.(view);
	}

	function scheduleViewReport() {
		if (viewTimer) clearTimeout(viewTimer);
		viewTimer = setTimeout(reportView, VIEW_DEBOUNCE_MS);
	}

	// Mid-gesture reporting: fired on every `move` frame, reports whenever the
	// throttle window has elapsed, so a long drag/zoom/flight streams viewport
	// reports every VIEW_THROTTLE_MS instead of staying silent until moveend.
	function throttledViewReport() {
		if (performance.now() - lastViewReport >= VIEW_THROTTLE_MS) reportView();
	}

	onMount(() => {
		let active = true;

		// Whether a pointer is currently pressed on the map — a pan about to start, or a
		// tap being aimed. Only consulted under reduced motion (see the rotate timer),
		// where the rotating line holds still while the user is mid-interaction rather
		// than churning text on top of it.
		let pointerHeld = false;
		const onPointerDown = () => (pointerHeld = true);
		const onPointerUp = () => (pointerHeld = false);
		mapEl.addEventListener('pointerdown', onPointerDown);
		// Release is tracked on the window: MapLibre captures the pointer during a drag,
		// so the pointerup/cancel can land outside the map element.
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);

		// Advance every pill's rotating food-item line on one shared timer. This only
		// rewrites text inside a fixed-size box, so it never wakes the layout loop.
		// Under prefers-reduced-motion we additionally hold the line steady while the
		// user is interacting — the camera is moving (pan/zoom/fly) or a pointer is
		// pressed — so the auto-updating text only cycles once the map is settled and
		// released (the swap's fade is dropped separately, in CSS). With reduced motion
		// off the line advances unconditionally, exactly as before.
		const rotateTimer = setInterval(() => {
			if (prefersReducedMotion.current && (map?.isMoving() || pointerHeld)) return;
			rotateTick += 1;
		}, ROTATE_INTERVAL_MS);

		(async () => {
			lib = await import('maplibre-gl');
			if (!active) return;

			map = new lib.Map({
				container: mapEl,
				style: mapStyle(),
				center: toLngLat(initialCenter ?? DEFAULT_CENTER),
				zoom: initialZoom ?? DEFAULT_ZOOM,
				maxZoom: MAX_ZOOM,
				// The camera stays flat: no tilt from any input. `maxPitch: 0` is the hard
				// cap (covers keyboard and any future handler); the two gesture flags stop
				// the touch two-finger drag and the right-click drag from even trying, so
				// they don't eat pointer input for a no-op. Rotation stays enabled.
				maxPitch: 0,
				touchPitch: false,
				pitchWithRotate: false,
				// The OSM credit is shown; MapLibre adds no self-attribution of its own.
				attributionControl: { compact: false }
			});

			// Zoom control sits bottom-left, clear of the floating search (top-left)
			// that overlays the full-screen map. No compass: rotation isn't part of the
			// interaction.
			map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-left');

			// The pills are pointer-transparent so wheel-zoom, drag-pan and pinch pass
			// straight through to the map even when the cursor is over one. That means
			// selection and the hover cursor can't come from DOM events on the pills, so we
			// resolve them here by hit-testing the click/hover point against the pill boxes
			// the engine is laying out. A tap anywhere on a venue's label — its name or the
			// rotating food-item line beneath it — selects that venue; a tap on bare map
			// reports a deselect so the parent can close an open location.
			map.on('click', (e) => {
				const id = engine.hitTest(e.point.x, e.point.y, HIT_SLOP);
				if (id) onselect?.(id);
				else ondeselect?.();
			});
			map.on('mousemove', (e) => {
				const mp = map;
				if (!mp) return;
				const hit = engine.hitTest(e.point.x, e.point.y, HIT_SLOP);
				mp.getCanvas().style.cursor = hit ? 'pointer' : '';
			});

			// Any camera motion or container resize wakes the (possibly parked) layout
			// loop so the pills re-project and re-settle, then it parks itself again.
			map.on('move', wake);
			map.on('resize', wake);

			// Report the viewport as it changes so the parent can load data for it:
			// throttled DURING movement (pans, zooms and programmatic flights all fire
			// `move`), so fetching starts while the camera is still in motion, plus a
			// debounced trailing report on `moveend` for the exact settled view.
			map.on('move', throttledViewReport);
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
				// Hand the live map to the parent so an overlay can project through its
				// camera (the landing's 3D space figures).
				onmap?.(map);
				// Dev-only: lazily mount the grid-cell debug overlay now the style is loaded
				// (its layers need a parsed style). Gated on the compile-time `DEV`, so a
				// production build drops this branch and never emits the GridDebug chunk —
				// the whole debug feature tree-shakes away.
				if (DEV) {
					// Expose the live map for headless/console debugging (e.g. verifying the
					// $lib/globe-space projection). DEV-gated, so it never ships to prod.
					(globalThis as unknown as { __map?: MapLibreMap }).__map = map;
					const debugMap = map;
					void import('$lib/dev/GridDebug.svelte')
						.then((mod) => {
							if (active) gridDebug = { Comp: mod.default, map: debugMap };
						})
						.catch((err) => console.error('grid debug overlay failed to load', err));
				}
			});
		})();

		return () => {
			active = false;
			ready = false;
			running = false;
			if (rafId) cancelAnimationFrame(rafId);
			if (viewTimer) clearTimeout(viewTimer);
			mapEl.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
			clearInterval(rotateTimer);
			engine.clear();
			onmap?.(null);
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
	// only an actual change of selection flies the camera. Clearing the selection
	// glides the venue back from the panel-inset centre to the middle of the full
	// viewport as the panel leaves: it pans by the same screen offset the selection
	// fly applied (in reverse), computed against the CURRENT view so it stays right
	// even if the user panned while the panel was open. Wakes the loop so the new
	// pill's highlight repaints even if the camera doesn't move.
	$effect(() => {
		if (!ready) return;
		const id = selected?.id ?? null;
		if (id && id !== lastSelectedId) {
			flyToSelected();
		} else if (!id && lastSelectedId) {
			const [dx, dy] = lastSelectionOffset;
			if (map && (dx || dy)) {
				const c = map.project(map.getCenter());
				const center = map.unproject([c.x + dx, c.y + dy]);
				map.easeTo({ center, duration: FLY_DURATION_MS });
			}
			lastSelectionOffset = [0, 0];
		}
		lastSelectedId = id;
		wake();
	});

	// Fly to a focus target when its key changes. Keeps the user's zoom if
	// they're already closer than FOCUS_MIN_ZOOM, so a fly from a street-level
	// view doesn't jump back out. Unlike selection, this never selects or
	// highlights — it only moves the camera.
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
	<div class="map" bind:this={mapEl} role="application" aria-label={m.map_aria()}></div>
	<!-- Pills are presentational: pointer-transparent so map gestures pass through, with
	     click-to-select handled by the map's hit-test (see onMount). Each pill shows the
	     venue name and, beneath it, a rotating food-item line. The accessible path to
	     the same venues is the visually hidden results list in the map page
	     (+page.svelte), which renders them as real focusable buttons. -->
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
				<!-- Top row: the venue name, with the count of items matching the active
				     filter (its whole menu when nothing is filtered) pinned to the right.
				     The count is absent when the venue has no items to show. -->
				<div class="pill__head">
					<span class="pill__name">{item.name}</span>
					{#if names.length > 0}
						<span class="pill__count">{m.menu_items_count({ count: names.length })}</span>
					{/if}
				</div>
				<!-- The rotating food-item line: the current item, ellipsized within a fixed
				     box so the pill never resizes as it cycles. Absent when the venue has no
				     items to show. -->
				{#if current !== null}
					<span class="pill__sub">
						{#key current}
							<span class="pill__item">{current}</span>
						{/key}
					</span>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Dev-only grid-cell debug overlay. `DEV` is a compile-time constant (Vite inlines
	     `import.meta.env.DEV` to `false` in prod), so this whole block — and the
	     lazily-imported component it mounts — is dropped from production builds. -->
	{#if DEV && gridDebug}
		{@const { Comp, map: debugMap } = gridDebug}
		<Comp map={debugMap} />
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
		height: 100%;
		width: 100%;
		/* Deep space behind the globe. The MapLibre canvas is transparent in the gap
		   around the zoomed-out globe (globe projection paints no backdrop there), so
		   this shows through as the space colour; zoomed in, the opaque tiles cover it. */
		background: #070a14;
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
	   the line stays legible even under a short venue name. The width is then fixed for
	   that pill, so the rotating item — which ellipsizes within it — never resizes the
	   pill or perturbs the force layout as it cycles. */
	.pill--has-item {
		min-width: 8rem;
		max-width: 15rem;
	}

	/* The top line: the venue name (flexes and ellipsizes) followed by the item count
	   pinned to the right. */
	.pill__head {
		display: flex;
		align-items: baseline;
		gap: 0.45em;
	}

	.pill__name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 500;
	}

	/* The item count, sitting next to the name and never shrinking so it stays legible
	   under a long (ellipsized) venue name. */
	.pill__count {
		flex: none;
		/* 45% black (≈3.5:1 on the white pill) fails WCAG 1.4.3 for 11px semibold text;
		   the muted token (#5c5c66, ≈6.3:1) clears it with no visible design change. */
		color: var(--color-text-muted);
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	/* The second line: the rotating item name, which flexes and ellipsizes within the
	   pill's fixed width. */
	.pill__sub {
		display: flex;
		align-items: baseline;
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

	@keyframes pill-item-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* Reduced motion: swap each item in instantly instead of fading. The rotation
	   itself is also paused during map interaction for these users (see the rotate
	   timer in the script). */
	@media (prefers-reduced-motion: reduce) {
		.pill__item {
			animation: none;
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

	.pill--selected .pill__count {
		color: rgba(255, 255, 255, 0.7);
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

	/* On narrow (mobile) screens, hide the +/- zoom control: pinch-to-zoom is the
	   native gesture there, and dropping the buttons hands the map back its corner
	   (the search row now floats along the bottom edge). The zoom control is the only
	   thing docked bottom-left, so hiding that corner removes just those buttons. */
	@media (max-width: 48rem) {
		.map :global(.maplibregl-ctrl-bottom-left) {
			display: none;
		}
	}
</style>
