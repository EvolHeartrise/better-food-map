<script lang="ts">
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';
	import type { Map as MapLibreMap, Marker, Popup, StyleSpecification } from 'maplibre-gl';
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
	// particular city. Stored `[lat, lng]` to match the prop contract; converted to
	// MapLibre's `[lng, lat]` order at the call sites via `toLngLat`.
	const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];
	// MapLibre's camera zoom runs one level "lower" than Leaflet's for the same
	// scale (its world base is a 512px tile vs Leaflet's 256px), so these are the
	// old Leaflet values minus one: DEFAULT 13→12, SELECTED 16→15.
	const DEFAULT_ZOOM = 12;
	// Zoom level used when flying to a single selected location.
	const SELECTED_ZOOM = 15;
	// Fly animation duration when centering on a selected location (milliseconds —
	// MapLibre takes ms, where Leaflet took seconds).
	const FLY_DURATION_MS = 600;
	// OpenStreetMap's raster tiles stop at z19; cap the camera there so the user
	// can't zoom past real tile data into blurry overzoomed scaling.
	const MAX_ZOOM = 19;
	// Marker fill, matching the app's accent (--color-accent) so pins read as part
	// of the brand rather than MapLibre's default blue.
	const MARKER_COLOR = '#2f6f4f';
	// Grow the reported box beyond the strictly-visible bounds by this fraction of
	// each span, so markers just off screen are already loaded when the user nudges
	// the map, and small pans don't trigger a refetch. 0.2 = 20% on every side.
	const BOUNDS_PADDING = 0.2;
	// Debounce (ms) before reporting a new viewport, so a drag or pinch settles into
	// a single fetch rather than firing on every intermediate `moveend`.
	const VIEW_DEBOUNCE_MS = 250;

	let mapEl: HTMLDivElement;

	// MapLibre's JS is imported dynamically inside onMount (client-only) because it
	// touches `window` at module load; the types are erased at compile time so
	// importing them is fine. `lib` holds the module namespace once loaded.
	let lib: typeof import('maplibre-gl') | null = null;
	let map: MapLibreMap | null = null;
	// Markers (with their hover popups) keyed by location id, so we can open the
	// selected one's popup and clear them all on re-render. A plain (non-reactive)
	// dictionary on purpose: it's an imperative cache written and read within the
	// same $effect, so reactivity would self-invalidate it.
	let markersById: Record<string, { marker: Marker; popup: Popup }> = {};

	// Becomes true once the map's first render is done; effects below gate on it so
	// they don't fire against a half-built map (the import + style load are async).
	let ready = $state(false);

	// Pending debounced viewport report (see scheduleViewReport).
	let viewTimer: ReturnType<typeof setTimeout> | null = null;
	// The last selected id we flew to, so re-renders (e.g. a viewport refetch) don't
	// re-fly to an already-open location — only a genuine change of selection does.
	let lastSelectedId: string | null = null;

	// The prop contract carries centres as `[lat, lng]` (Leaflet's order, and how
	// the page supplies the IP-detected centre); MapLibre wants `[lng, lat]`.
	function toLngLat([lat, lng]: [number, number]): [number, number] {
		return [lng, lat];
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

	// The map style: OpenStreetMap raster tiles on a 3D globe projection. MapLibre
	// renders this flat (Web Mercator) when zoomed in and smoothly curves it into a
	// globe as the user zooms out, with no work on our part. The `sky` atmosphere
	// gives the zoomed-out globe its halo and fades out by the time the map has
	// flattened (≈ zoom 7), so it never intrudes on the street-level view.
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

	function renderMarkers() {
		if (!lib || !map) return;

		for (const { marker, popup } of Object.values(markersById)) {
			marker.remove();
			popup.remove();
		}
		markersById = {};

		// Show every in-view location, plus the selected location even when it falls
		// outside the current viewport (e.g. opened from a shared link).
		const toRender = [...locations];
		if (selected && !toRender.some((loc) => loc.id === selected.id)) {
			toRender.push(selected);
		}

		for (const loc of toRender) {
			const lngLat: [number, number] = [loc.longitude, loc.latitude];
			// The popup is managed by hand (rather than `marker.setPopup`) so its
			// open/close is driven purely by hover and the selection effect — a click
			// on the marker selects the place instead of toggling the popup.
			const popup = new lib.Popup({
				closeButton: false,
				closeOnClick: false,
				anchor: 'bottom',
				offset: 36
			})
				.setLngLat(lngLat)
				.setHTML(tooltipHtml(loc));

			const marker = new lib.Marker({ color: MARKER_COLOR }).setLngLat(lngLat).addTo(map);

			const el = marker.getElement();
			el.style.cursor = 'pointer';
			el.addEventListener('mouseenter', () => {
				if (map) popup.addTo(map);
			});
			el.addEventListener('mouseleave', () => popup.remove());
			el.addEventListener('click', (event) => {
				// Keep the click from reaching the map (which would otherwise treat it
				// as a background click) and open the location's detail panel.
				event.stopPropagation();
				onselect?.(loc.id);
			});

			markersById[loc.id] = { marker, popup };
		}
	}

	// Smoothly zoom in on the selected location.
	function flyToSelected() {
		if (!map || !selected) return;
		map.flyTo({
			center: [selected.longitude, selected.latitude],
			zoom: SELECTED_ZOOM,
			duration: FLY_DURATION_MS
		});
		const entry = markersById[selected.id];
		if (entry) entry.popup.addTo(map);
	}

	// The current visible box, grown by BOUNDS_PADDING, paired with the zoom level.
	// Latitude is clamped to the valid range; longitude is left as-is (a box across
	// the antimeridian isn't supported — the same planar assumption used elsewhere).
	// Reported at every zoom now that the page has no fetch floor: when zoomed out
	// onto the globe this is the visible cap of the world, and the server's result
	// cap (MAP_RESULT_LIMIT) is what keeps that fetch bounded.
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
			lib = await import('maplibre-gl');
			if (!active) return;

			map = new lib.Map({
				container: mapEl,
				style: mapStyle(),
				center: toLngLat(initialCenter ?? DEFAULT_CENTER),
				zoom: DEFAULT_ZOOM,
				maxZoom: MAX_ZOOM,
				// The OSM credit is shown; MapLibre adds no self-attribution of its own.
				attributionControl: { compact: false }
			});

			// Zoom control sits bottom-left, clear of the floating search (top-left)
			// and results (top-right) panels that overlay the full-screen map. No
			// compass: rotation isn't part of the interaction, matching the old map.
			map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-left');

			// Report the viewport as it changes so the parent can load data for it.
			// `moveend` fires after both pans and zooms (and programmatic flights) settle.
			map.on('moveend', scheduleViewReport);

			// `load` fires once the style is parsed and the first frame is painted —
			// only then are markers safe to add and the opening view worth reporting.
			map.on('load', () => {
				if (!active) return;
				ready = true;
				renderMarkers();
				// Kick off the first load immediately (no debounce) for the opening view.
				reportView();
			});
		})();

		return () => {
			active = false;
			ready = false;
			if (viewTimer) clearTimeout(viewTimer);
			if (map) {
				map.remove();
				map = null;
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
	.map :global(.maplibregl-ctrl-bottom-left) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-left: env(safe-area-inset-left);
	}

	.map :global(.maplibregl-ctrl-bottom-right) {
		margin-bottom: env(safe-area-inset-bottom);
		margin-right: env(safe-area-inset-right);
	}
</style>
