<script lang="ts">
	import 'leaflet/dist/leaflet.css';
	import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
	import markerIcon from 'leaflet/dist/images/marker-icon.png';
	import markerShadow from 'leaflet/dist/images/marker-shadow.png';
	import { onMount } from 'svelte';
	import type * as Leaflet from 'leaflet';

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

	let { locations }: { locations: Location[] } = $props();

	const VANCOUVER: [number, number] = [49.2827, -123.1207];
	const DEFAULT_ZOOM = 12;

	let mapEl: HTMLDivElement;

	// Leaflet's JS is imported dynamically inside onMount (client-only) to stay
	// SSR-safe; the types are erased at compile time so importing them is fine.
	let L: typeof Leaflet | null = null;
	let map: Leaflet.Map | null = null;
	let markerLayer: Leaflet.LayerGroup | null = null;
	// A concrete marker icon built from bundled assets. We deliberately avoid
	// `L.Icon.Default` because its `_getIconUrl` prepends a detected `imagePath`
	// to the configured URL, which corrupts our already-resolved asset URLs into
	// 404s. An explicit `L.icon` sidesteps that entirely.
	let markerIconDef: Leaflet.Icon | null = null;

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

	function popupHtml(loc: Location): string {
		const parts: string[] = [`<strong>${escapeHtml(loc.name)}</strong>`];
		const label = categoryLabel(loc.category);
		if (label) parts.push(`<span>${escapeHtml(label)}</span>`);
		if (loc.address) parts.push(`<span>${escapeHtml(loc.address)}</span>`);
		parts.push(`<a href="/locations/${escapeHtml(loc.id)}">View menu &rarr;</a>`);
		return `<div class="map-popup">${parts.join('<br />')}</div>`;
	}

	function renderMarkers() {
		if (!L || !map || !markerLayer || !markerIconDef) return;

		markerLayer.clearLayers();

		const points: Array<[number, number]> = [];
		for (const loc of locations) {
			const point: [number, number] = [loc.latitude, loc.longitude];
			points.push(point);
			L.marker(point, { icon: markerIconDef }).bindPopup(popupHtml(loc)).addTo(markerLayer);
		}

		if (points.length > 0) {
			map.fitBounds(points, { padding: [40, 40] });
		} else {
			map.setView(VANCOUVER, DEFAULT_ZOOM);
		}
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
		})();

		return () => {
			active = false;
			if (map) {
				map.remove();
				map = null;
				markerLayer = null;
			}
		};
	});

	// Re-render markers when the `locations` prop changes after the map is ready.
	$effect(() => {
		// Reading `locations` here registers it as a dependency, so this effect
		// re-runs (and re-renders the markers) whenever the prop changes.
		if (locations && map && markerLayer) {
			renderMarkers();
		}
	});
</script>

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

	.map :global(.map-popup a) {
		font-weight: 600;
	}
</style>
