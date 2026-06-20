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
		category: 'cafe' | 'fast_food' | 'restaurant' | null;
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
		drawing = $bindable(false)
	}: {
		locations: Location[];
		selected?: Location | null;
		onselect?: (id: string) => void;
		polygon?: LatLng[] | null;
		drawing?: boolean;
	} = $props();

	const VANCOUVER: [number, number] = [49.2827, -123.1207];
	const DEFAULT_ZOOM = 12;
	// Matches --color-accent; Leaflet path strokes/fills need a concrete colour.
	const ACCENT = '#2f6f4f';
	// How close (in pixels) a click must be to the first vertex to close the ring.
	const CLOSE_TOLERANCE_PX = 14;
	// View-fitting animation. We debounce so rapid result changes while the user is
	// typing settle into a single smooth flight instead of jittering per keystroke.
	const FIT_DEBOUNCE_MS = 300;
	const FLY_DURATION = 0.6; // seconds
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

	// Pending debounced view-fit (see scheduleFit).
	let fitTimer: ReturnType<typeof setTimeout> | null = null;

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

	// Smoothly zoom in on the selected location. Cancels any pending results-fit so
	// the two don't fight over the camera.
	function flyToSelected() {
		if (!L || !map || !selected) return;
		if (fitTimer) {
			clearTimeout(fitTimer);
			fitTimer = null;
		}
		map.flyTo([selected.latitude, selected.longitude], SELECTED_ZOOM, {
			duration: FLY_DURATION
		});
		markersById[selected.id]?.openTooltip();
	}

	// Smoothly fly the view to frame the current locations. Suppressed while the
	// user is actively drawing (so the map doesn't move under the cursor) or while a
	// location is selected (the camera is pinned to it) — a committed area still
	// refits as results filter in/out within it.
	function fitToLocations() {
		if (!L || !map || drawing || selected) return;

		const points = locations.map((loc) => [loc.latitude, loc.longitude] as [number, number]);

		if (points.length > 0) {
			// Frame the visible locations.
			map.flyToBounds(points, {
				padding: [40, 40],
				maxZoom: FIT_MAX_ZOOM,
				duration: FLY_DURATION
			});
		} else if (polygon && polygon.length >= 3) {
			// An area is set but nothing matches inside it — frame the area itself so
			// the user stays oriented to their selection.
			map.flyToBounds(polygon, {
				padding: [40, 40],
				maxZoom: FIT_MAX_ZOOM,
				duration: FLY_DURATION
			});
		} else {
			// No results and no area: return to the default city view.
			map.flyTo(VANCOUVER, DEFAULT_ZOOM, { duration: FLY_DURATION });
		}
	}

	// Debounce the fit: each call resets the timer, so a burst of result changes
	// (e.g. typing a query) produces one flight once things settle. Clearing the
	// timer here also cancels a pending fit when drawing begins.
	function scheduleFit() {
		if (fitTimer) {
			clearTimeout(fitTimer);
			fitTimer = null;
		}
		if (!map || drawing || selected) return;
		fitTimer = setTimeout(() => {
			fitTimer = null;
			fitToLocations();
		}, FIT_DEBOUNCE_MS);
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
			map = L.map(mapEl, { zoomControl: false }).setView(VANCOUVER, DEFAULT_ZOOM);
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
			if (fitTimer) {
				clearTimeout(fitTimer);
				fitTimer = null;
			}
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

	// Re-render markers and move the camera when inputs change after the map is
	// ready. `renderMarkers()` reads `locations`, `drawing` and `selected`, so this
	// effect re-runs on any of them. Markers update instantly; camera moves are
	// animated. When a location is selected we fly to it; otherwise we (debounced)
	// refit to frame the current results. While drawing, the camera is left alone.
	// `polygon` changes flow through `locations` (the parent re-filters results).
	$effect(() => {
		if (!ready) return;
		renderMarkers();
		if (drawing) return;
		if (selected) flyToSelected();
		else scheduleFit();
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

<div
	class="map"
	bind:this={mapEl}
	role="application"
	aria-label="Map of food locations in Vancouver"
></div>

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
