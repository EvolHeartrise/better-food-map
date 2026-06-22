<script lang="ts">
	import 'leaflet/dist/leaflet.css';
	import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
	import markerIcon from 'leaflet/dist/images/marker-icon.png';
	import markerShadow from 'leaflet/dist/images/marker-shadow.png';
	import { onMount } from 'svelte';
	import type * as Leaflet from 'leaflet';
	import { categoryLabel, type Category } from '$lib/category';

	// A geographic bounding box reported to the parent as the visible area. Kept
	// structural (rather than imported from the server module) so this component
	// stays free of any server-only import.
	type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

	// Only the fields the map actually needs. Kept structural (rather than derived
	// from a remote's return type) so any location-shaped object can be passed in.
	type Location = {
		id: string;
		name: string;
		category: Category | null;
		latitude: number;
		longitude: number;
		address: string | null;
	};

	let {
		locations,
		// The currently selected location, shown zoomed-in with its detail panel
		// open on the page. When set, the map flies to it once and keeps its marker
		// visible even if it isn't among the in-view `locations`.
		selected = null,
		// Called with a location id when the user clicks a marker, so the parent can
		// open that location (the same action as clicking a result card).
		onselect,
		// Where the map opens, as `[lat, lng]` — typically the visitor's IP-detected
		// location. Falls back to DEFAULT_CENTER when absent (e.g. geolocation
		// unavailable). The camera otherwise only moves when the user pans/zooms or
		// selects a place — search/filter changes never move it.
		initialCenter = null,
		// Called (debounced) with the visible bounding box and zoom whenever the map
		// settles after a pan/zoom, plus once on load. The parent fetches location
		// data for this box, so only what's on screen is ever loaded.
		onviewchange
	}: {
		locations: Location[];
		selected?: Location | null;
		onselect?: (id: string) => void;
		initialCenter?: [number, number] | null;
		onviewchange?: (view: { bounds: Bounds; zoom: number }) => void;
	} = $props();

	// Fallback map center, used when no `initialCenter` is supplied (e.g. IP
	// geolocation is unavailable) — just a sensible starting view, not tied to any
	// particular city.
	const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];
	const DEFAULT_ZOOM = 13;
	// Fly animation duration when centering on a selected location.
	const FLY_DURATION = 0.6; // seconds
	// Zoom level used when flying to a single selected location.
	const SELECTED_ZOOM = 16;
	// Grow the reported box beyond the strictly-visible bounds by this fraction of
	// each span, so markers just off screen are already loaded when the user nudges
	// the map, and small pans don't trigger a refetch. 0.2 = 20% on every side.
	const BOUNDS_PADDING = 0.2;
	// Debounce (ms) before reporting a new viewport, so a drag or pinch settles into
	// a single fetch rather than firing on every intermediate `moveend`.
	const VIEW_DEBOUNCE_MS = 250;

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

	// Becomes true once the map is initialised; effects below gate on it so they
	// don't fire against a half-built map (the Leaflet import is async).
	let ready = $state(false);

	// Pending debounced viewport report (see scheduleViewReport).
	let viewTimer: ReturnType<typeof setTimeout> | null = null;
	// The last selected id we flew to, so re-renders (e.g. a viewport refetch) don't
	// re-fly to an already-open location — only a genuine change of selection does.
	let lastSelectedId: string | null = null;

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

		// Show every in-view location, plus the selected location even when it falls
		// outside the current viewport (e.g. opened from a shared link).
		const toRender = [...locations];
		if (selected && !toRender.some((loc) => loc.id === selected.id)) {
			toRender.push(selected);
		}

		for (const loc of toRender) {
			const point: [number, number] = [loc.latitude, loc.longitude];
			const marker = L.marker(point, { icon: markerIconDef })
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

	// The current visible box, grown by BOUNDS_PADDING, paired with the zoom level.
	// Latitude is clamped to the valid range; longitude is left as-is (a box across
	// the antimeridian isn't supported — the same planar assumption used elsewhere).
	function currentView(): { bounds: Bounds; zoom: number } | null {
		if (!map) return null;
		const b = map.getBounds();
		const south = b.getSouth();
		const north = b.getNorth();
		const west = b.getWest();
		const east = b.getEast();
		const padLat = (north - south) * BOUNDS_PADDING;
		const padLng = (east - west) * BOUNDS_PADDING;
		return {
			bounds: {
				minLat: Math.max(-90, south - padLat),
				maxLat: Math.min(90, north + padLat),
				minLng: west - padLng,
				maxLng: east + padLng
			},
			zoom: map.getZoom()
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
			// Report the viewport as it changes so the parent can load data for it.
			// `moveend` fires after both pans and zooms settle.
			map.on('moveend', scheduleViewReport);

			renderMarkers();
			ready = true;
			// Kick off the first load immediately (no debounce) for the opening view.
			reportView();
		})();

		return () => {
			active = false;
			ready = false;
			if (viewTimer) clearTimeout(viewTimer);
			if (map) {
				map.remove();
				map = null;
				markerLayer = null;
				markersById = {};
			}
		};
	});

	// Re-render markers when the in-view locations (or the selection) change. This
	// only repaints markers; it never moves the camera, so searching/filtering or a
	// viewport refetch leaves the view exactly where the user put it.
	$effect(() => {
		if (!ready) return;
		renderMarkers();
	});

	// Centre on a newly-selected location. Guarded by `lastSelectedId` so a marker
	// re-render (e.g. data refetched after the fly's own move) doesn't re-trigger
	// it — only an actual change of selection flies the camera.
	$effect(() => {
		if (!ready) return;
		const id = selected?.id ?? null;
		if (id && id !== lastSelectedId) flyToSelected();
		lastSelectedId = id;
	});
</script>

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

	/* Keep the zoom control and attribution clear of notches and the home indicator
	   on devices that report safe-area insets (the viewport is `viewport-fit=cover`). */
	.map :global(.leaflet-bottom.leaflet-left) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-left: env(safe-area-inset-left);
	}

	.map :global(.leaflet-bottom.leaflet-right) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-right: env(safe-area-inset-right);
	}
</style>
