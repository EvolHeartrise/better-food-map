<script lang="ts">
	import 'leaflet/dist/leaflet.css';
	import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
	import markerIcon from 'leaflet/dist/images/marker-icon.png';
	import markerShadow from 'leaflet/dist/images/marker-shadow.png';
	import { onMount } from 'svelte';
	import type * as Leaflet from 'leaflet';
	import type { LatLng } from '$lib/geo';

	// Only the fields the map actually needs. Kept structural (rather than derived
	// from a remote's return type) so any location-shaped object can be passed in.
	type Location = {
		id: string;
		name: string;
		category: 'cafe' | 'fast_food' | 'restaurant' | 'bakery' | null;
		latitude: number;
		longitude: number;
		address: string | null;
	};

	let {
		locations,
		// The currently selected location, shown zoomed-in with its detail panel
		// open on the page. When set, the map flies to it (instead of fitting all
		// results) and keeps its marker visible even if it's been filtered out.
		selected = null,
		// Called with a location id when the user clicks a marker, so the parent can
		// open that location (the same action as clicking a result card).
		onselect,
		// The drawn area constraint, as a ring of `[lat, lng]` vertices (or `null`).
		// Bindable: the map writes it when the user finishes drawing or drags a
		// vertex, and the parent can clear it by setting it back to `null`.
		polygon = $bindable(null),
		// Whether the map is in draw mode. Bindable so a parent button can start
		// drawing and the map can end it (on finish / cancel).
		drawing = $bindable(false),
		// Floating UI elements that overlap the map (e.g. the search and results
		// panels). When fitting results into view we reserve space for whichever of
		// these currently overlap, so markers are never framed underneath them.
		// Measured live at fit time, so it adapts to panel size, the stacked mobile
		// layout, or a panel being hidden — no resize listener needed.
		obstacles = [],
		// Where the map opens, as `[lat, lng]` — typically the visitor's IP-detected
		// location. When provided, the camera opens here and the one-time
		// fit-to-all-results on load is skipped, so the map starts "where you are".
		// Falls back to DEFAULT_CENTER when absent (e.g. geolocation unavailable).
		initialCenter = null
	}: {
		locations: Location[];
		selected?: Location | null;
		onselect?: (id: string) => void;
		polygon?: LatLng[] | null;
		drawing?: boolean;
		obstacles?: HTMLElement[];
		initialCenter?: [number, number] | null;
	} = $props();

	// Fallback map center, used when no `initialCenter` is supplied (e.g. IP
	// geolocation is unavailable) — just a sensible starting view, not tied to any
	// particular city.
	const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];
	const DEFAULT_ZOOM = 13;
	// Matches --color-accent; Leaflet path strokes/fills need a concrete colour.
	const ACCENT = '#2f6f4f';
	// How close (in pixels) a click must be to the first vertex to close the ring.
	const CLOSE_TOLERANCE_PX = 14;
	// View-fitting animation duration. Fits run immediately when results change (no
	// debounce) so the camera tracks the search without lag; Leaflet redirects an
	// in-flight flight smoothly if the results change again before it lands.
	const FLY_DURATION = 0.6; // seconds
	// Minimum gap (px) kept between a framed marker and the map edge.
	const FIT_BASE_PADDING = 40;
	// Extra breathing room (px) between a marker and a panel it's tucked beside.
	const FIT_PANEL_MARGIN = 12;
	// Cap how far a fit can zoom in, so one or two close results don't slam to
	// street level.
	const FIT_MAX_ZOOM = 16;
	// Zoom level used when flying to a single selected location.
	const SELECTED_ZOOM = 16;

	let mapEl: HTMLDivElement;

	// Leaflet's JS is imported dynamically inside onMount (client-only) to stay
	// SSR-safe; the types are erased at compile time so importing them is fine.
	let L: typeof Leaflet | null = null;
	let map: Leaflet.Map | null = null;
	let markerLayer: Leaflet.LayerGroup | null = null;
	// Markers keyed by location id, so we can open the selected one's tooltip. A
	// plain (non-reactive) dictionary on purpose: it's an imperative cache written
	// and read within the same $effect, so reactivity would self-invalidate it.
	let markersById: Record<string, Leaflet.Marker> = {};
	// A concrete marker icon built from bundled assets. We deliberately avoid
	// `L.Icon.Default` because its `_getIconUrl` prepends a detected `imagePath`
	// to the configured URL, which corrupts our already-resolved asset URLs into
	// 404s. An explicit `L.icon` sidesteps that entirely.
	let markerIconDef: Leaflet.Icon | null = null;
	// Small square handle for dragging committed-polygon vertices.
	let vertexIcon: Leaflet.DivIcon | null = null;

	// Becomes true once the map is initialised; effects below gate on it so they
	// don't fire against a half-built map (the Leaflet import is async).
	let ready = $state(false);

	// --- Drawing state (imperative; not reactive) -----------------------------
	// Vertices clicked so far in the current draw session.
	let drawPoints: LatLng[] = [];
	let drawLayer: Leaflet.LayerGroup | null = null; // in-progress visuals
	let drawLine: Leaflet.Polyline | null = null; // edges between clicked points
	let drawDots: Leaflet.LayerGroup | null = null; // vertex markers
	let rubberBand: Leaflet.Polyline | null = null; // last point → cursor
	// The committed (finished) polygon plus its draggable vertex handles.
	let committedLayer: Leaflet.LayerGroup | null = null;

	function categoryLabel(category: Location['category']): string {
		if (!category) return '';
		if (category === 'fast_food') return 'Fast food';
		return category.charAt(0).toUpperCase() + category.slice(1);
	}

	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// Hover label for a marker. Clicking the marker opens the location's detail
	// panel (via `onselect`), so this is just a quick at-a-glance preview.
	function tooltipHtml(loc: Location): string {
		const parts: string[] = [`<strong>${escapeHtml(loc.name)}</strong>`];
		const label = categoryLabel(loc.category);
		if (label) parts.push(`<span>${escapeHtml(label)}</span>`);
		if (loc.address) parts.push(`<span>${escapeHtml(loc.address)}</span>`);
		return `<div class="map-tip">${parts.join('<br />')}</div>`;
	}

	function renderMarkers() {
		if (!L || !map || !markerLayer || !markerIconDef) return;

		markerLayer.clearLayers();
		markersById = {};

		// Show every result, plus the selected location even when it falls outside
		// the current results (e.g. opened from a shared link with no active search).
		const toRender = [...locations];
		if (selected && !toRender.some((loc) => loc.id === selected.id)) {
			toRender.push(selected);
		}

		for (const loc of toRender) {
			const point: [number, number] = [loc.latitude, loc.longitude];
			// While drawing, markers are non-interactive so clicks fall through to
			// the map (adding vertices) instead of selecting a location.
			const marker = L.marker(point, { icon: markerIconDef, interactive: !drawing })
				.bindTooltip(tooltipHtml(loc), { direction: 'top' })
				.addTo(markerLayer);
			marker.on('click', () => onselect?.(loc.id));
			markersById[loc.id] = marker;
		}
	}

	// Smoothly zoom in on the selected location.
	function flyToSelected() {
		if (!L || !map || !selected) return;
		map.flyTo([selected.latitude, selected.longitude], SELECTED_ZOOM, {
			duration: FLY_DURATION
		});
		markersById[selected.id]?.openTooltip();
	}

	// Scale a padding pair down proportionally if together they'd exceed `max`, so
	// opposing panels can never reserve the entire axis and leave no room to fit.
	function clampPair(a: number, b: number, max: number): [number, number] {
		const total = a + b;
		if (total <= max || total === 0) return [a, b];
		const scale = max / total;
		return [a * scale, b * scale];
	}

	// Reserve space for the floating panels so fitted results never land underneath
	// them. For each overlapping obstacle we measure its rect against the map
	// container and grow the padding on the edge it's docked to: narrow side panels
	// push left/right, full-width panels (the stacked mobile layout) push top/bottom.
	// Returns Leaflet paddingTopLeft / paddingBottomRight points.
	function computeFitPadding(): {
		paddingTopLeft: [number, number];
		paddingBottomRight: [number, number];
	} {
		let left = FIT_BASE_PADDING;
		let right = FIT_BASE_PADDING;
		let top = FIT_BASE_PADDING;
		let bottom = FIT_BASE_PADDING;

		const c = mapEl.getBoundingClientRect();
		for (const el of obstacles) {
			const r = el?.getBoundingClientRect();
			// Skip missing or hidden (display:none → zero-sized) panels.
			if (!r || r.width === 0 || r.height === 0) continue;

			if (r.width > c.width * 0.6) {
				// Spans most of the width → docked to the top or bottom edge.
				if (r.top - c.top < c.bottom - r.bottom) {
					top = Math.max(top, r.bottom - c.top + FIT_PANEL_MARGIN);
				} else {
					bottom = Math.max(bottom, c.bottom - r.top + FIT_PANEL_MARGIN);
				}
			} else {
				// A narrow panel docked to the left or right edge.
				if (r.left - c.left < c.right - r.right) {
					left = Math.max(left, r.right - c.left + FIT_PANEL_MARGIN);
				} else {
					right = Math.max(right, c.right - r.left + FIT_PANEL_MARGIN);
				}
			}
		}

		// Keep a fittable strip in the middle even if the panels are oversized.
		[left, right] = clampPair(left, right, c.width * 0.8);
		[top, bottom] = clampPair(top, bottom, c.height * 0.8);

		return { paddingTopLeft: [left, top], paddingBottomRight: [right, bottom] };
	}

	// Smoothly fly the view to frame the current locations. Suppressed while the
	// user is actively drawing (so the map doesn't move under the cursor) or while a
	// location is selected (the camera is pinned to it) — a committed area still
	// refits as results filter in/out within it.
	function fitToLocations() {
		if (!L || !map || drawing || selected) return;

		const points = locations.map((loc) => [loc.latitude, loc.longitude] as [number, number]);
		const { paddingTopLeft, paddingBottomRight } = computeFitPadding();

		if (points.length > 0) {
			// Frame the visible locations.
			map.flyToBounds(points, {
				paddingTopLeft,
				paddingBottomRight,
				maxZoom: FIT_MAX_ZOOM,
				duration: FLY_DURATION
			});
		} else if (polygon && polygon.length >= 3) {
			// An area is set but nothing matches inside it — frame the area itself so
			// the user stays oriented to their selection.
			map.flyToBounds(polygon, {
				paddingTopLeft,
				paddingBottomRight,
				maxZoom: FIT_MAX_ZOOM,
				duration: FLY_DURATION
			});
		} else {
			// No results and no area: return to the default view.
			map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: FLY_DURATION });
		}
	}

	// --- Draw mode ------------------------------------------------------------

	function startDraw() {
		if (!L || !map) return;

		drawPoints = [];
		drawLayer = L.layerGroup().addTo(map);
		drawLine = L.polyline([], { color: ACCENT, weight: 2, dashArray: '4 5' }).addTo(drawLayer);
		rubberBand = L.polyline([], {
			color: ACCENT,
			weight: 2,
			dashArray: '4 5',
			opacity: 0.55
		}).addTo(drawLayer);
		drawDots = L.layerGroup().addTo(drawLayer);

		// Double-click would otherwise zoom; we want it free for future use and to
		// avoid surprises mid-draw.
		map.doubleClickZoom.disable();
		map.on('click', onDrawClick);
		map.on('mousemove', onDrawMouseMove);
		mapEl.classList.add('drawing');
	}

	function stopDraw() {
		if (map) {
			map.off('click', onDrawClick);
			map.off('mousemove', onDrawMouseMove);
			map.doubleClickZoom.enable();
		}
		mapEl?.classList.remove('drawing');
		drawLayer?.remove();
		drawLayer = null;
		drawLine = null;
		rubberBand = null;
		drawDots = null;
		drawPoints = [];
	}

	function redrawInProgress() {
		if (!L || !drawLine || !drawDots) return;

		drawLine.setLatLngs(drawPoints);

		drawDots.clearLayers();
		drawPoints.forEach((pt, idx) => {
			// The first vertex is drawn larger as the visible "click here to close"
			// target once the ring has enough points.
			const isFirst = idx === 0;
			L!
				.circleMarker(pt, {
					radius: isFirst ? 6 : 4,
					color: ACCENT,
					weight: 2,
					fillColor: '#fff',
					fillOpacity: 1,
					interactive: false
				})
				.addTo(drawDots!);
		});
	}

	function onDrawClick(e: Leaflet.LeafletMouseEvent) {
		if (!map) return;

		// Clicking on (or very near) the first vertex closes the ring.
		if (drawPoints.length >= 3) {
			const first = map.latLngToContainerPoint(drawPoints[0]);
			if (first.distanceTo(e.containerPoint) <= CLOSE_TOLERANCE_PX) {
				finishDraw();
				return;
			}
		}

		drawPoints.push([e.latlng.lat, e.latlng.lng]);
		redrawInProgress();
	}

	function onDrawMouseMove(e: Leaflet.LeafletMouseEvent) {
		if (!rubberBand) return;
		if (drawPoints.length === 0) {
			rubberBand.setLatLngs([]);
			return;
		}
		const last = drawPoints[drawPoints.length - 1];
		rubberBand.setLatLngs([last, [e.latlng.lat, e.latlng.lng]]);
	}

	function finishDraw() {
		if (drawPoints.length < 3) return; // need a real polygon
		// Commit the ring and leave draw mode. The reactive effects below tear down
		// the in-progress layers and build the committed polygon from `polygon`.
		polygon = drawPoints.slice();
		drawing = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!drawing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			finishDraw();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			drawing = false; // cancel; `polygon` is left untouched
		}
	}

	// --- Committed polygon (with draggable vertices) --------------------------

	function buildCommitted(poly: LatLng[] | null) {
		if (!L || !map) return;

		committedLayer?.remove();
		committedLayer = null;

		if (!poly || poly.length < 3) return;

		committedLayer = L.layerGroup().addTo(map);

		// `interactive: false` so the fill never swallows clicks meant for the
		// markers beneath it.
		const ring = poly.map((pt) => L!.latLng(pt[0], pt[1]));
		const shape = L.polygon(ring, {
			color: ACCENT,
			weight: 2,
			fillColor: ACCENT,
			fillOpacity: 0.12,
			interactive: false
		}).addTo(committedLayer);

		poly.forEach((pt, idx) => {
			const handle = L!.marker(pt, { draggable: true, icon: vertexIcon!, keyboard: false });
			handle.on('drag', () => {
				// Live-update the shape as the handle moves (no prop write yet).
				ring[idx] = handle.getLatLng();
				shape.setLatLngs(ring);
			});
			handle.on('dragend', () => {
				// Commit the edited ring; rebuilds this layer from the new `polygon`.
				polygon = ring.map((p) => [p.lat, p.lng] as LatLng);
			});
			handle.addTo(committedLayer!);
		});
	}

	onMount(() => {
		let active = true;

		(async () => {
			L = (await import('leaflet')).default;
			if (!active) return;

			markerIconDef = L.icon({
				iconUrl: markerIcon,
				iconRetinaUrl: markerIcon2x,
				shadowUrl: markerShadow,
				// Leaflet's standard default-marker geometry.
				iconSize: [25, 41],
				iconAnchor: [12, 41],
				popupAnchor: [1, -34],
				tooltipAnchor: [16, -28],
				shadowSize: [41, 41]
			});

			vertexIcon = L.divIcon({
				className: 'vertex-handle',
				iconSize: [14, 14],
				iconAnchor: [7, 7]
			});

			// Zoom control sits bottom-left, clear of the floating search (top-left)
			// and results (top-right) panels that overlay the full-screen map.
			map = L.map(mapEl, { zoomControl: false }).setView(
				initialCenter ?? DEFAULT_CENTER,
				DEFAULT_ZOOM
			);
			L.control.zoom({ position: 'bottomleft' }).addTo(map);

			// Drop the optional "Leaflet" prefix; the OpenStreetMap credit below is
			// kept because the OSM tile policy / ODbL require attribution.
			map.attributionControl.setPrefix(false);

			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
				maxZoom: 19
			}).addTo(map);

			markerLayer = L.layerGroup().addTo(map);
			renderMarkers();
			ready = true;
		})();

		return () => {
			active = false;
			ready = false;
			if (map) {
				map.remove();
				map = null;
				markerLayer = null;
				markersById = {};
				drawLayer = null;
				committedLayer = null;
			}
		};
	});

	// Tracks the first post-ready effect run. On that run, when an `initialCenter`
	// was supplied, we skip the fit-to-results so the camera stays "where you are"
	// (the map already opened there) instead of jumping to frame every marker. All
	// later input changes (search/filter/select) fit and fly as normal. A plain
	// (non-reactive) flag on purpose — it's read and cleared within the effect.
	let firstRun = true;

	// Re-render markers and move the camera when inputs change after the map is
	// ready. `renderMarkers()` reads `locations`, `drawing` and `selected`, so this
	// effect re-runs on any of them. Markers update instantly; camera moves are
	// animated. When a location is selected we fly to it; otherwise we refit to
	// frame the current results. While drawing, the camera is left alone.
	// `polygon` changes flow through `locations` (the parent re-filters results).
	$effect(() => {
		if (!ready) return;
		renderMarkers();
		if (drawing) return;

		// Consume the one-time hold on the first run regardless of branch, so a map
		// opened straight to a selected location (shared link) still fits normally
		// once that selection is cleared.
		const skipFit = firstRun && initialCenter !== null;
		firstRun = false;

		if (selected) flyToSelected();
		else if (!skipFit) fitToLocations();
	});

	// Enter / leave draw mode in response to the bindable `drawing` flag.
	$effect(() => {
		if (!ready) return;
		if (drawing) startDraw();
		else stopDraw();
	});

	// (Re)build the committed polygon whenever it changes — including being
	// cleared (`null`) by the parent.
	$effect(() => {
		if (ready) buildCommitted(polygon);
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="map" bind:this={mapEl} role="application" aria-label="Map of food locations"></div>

<style>
	.map {
		height: 100%;
		width: 100%;
	}

	.map :global(.map-tip) {
		text-align: center;
		line-height: 1.35;
	}

	/* Crosshair cursor while drawing. `mapEl` is the Leaflet container, so this
	   override beats Leaflet's own `.leaflet-grab` cursor. */
	:global(.leaflet-container.drawing) {
		cursor: crosshair;
	}

	/* Draggable vertex handle for the committed polygon. */
	.map :global(.vertex-handle) {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		border: 2px solid var(--color-accent);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
		cursor: grab;
	}

	.map :global(.vertex-handle:active) {
		cursor: grabbing;
	}
</style>
