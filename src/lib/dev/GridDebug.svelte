<script lang="ts">
	// DEV-ONLY grid-cell debug overlay.
	//
	// This whole component is loaded through a `dev`-gated dynamic import in
	// <LocationMap> (`if (dev) import('$lib/dev/GridDebug.svelte')`). In a production
	// build `dev` from `$app/environment` is the literal `false`, so Rollup drops that
	// branch and never emits this chunk — the component, its geometry and its HUD are
	// tree-shaken out of prod entirely. Keep all debug-only code in here so that stays
	// true; the only thing <LocationMap> retains is the dead `if (dev)` branch.
	//
	// It visualizes the TWO lattices the map runs on, each as its own MapLibre GeoJSON
	// source + fill/line layer (so they curve with the globe and re-project every frame
	// for free — we only rebuild the feature set when the cells actually change):
	//   • the DATA-FETCH grid ($lib/grid) — the cells getMapCells requests/caches; and
	//   • the LABEL-DECLUTTER grid ($lib/label-layout) — the cells that thin name pills.

	import { onMount } from 'svelte';
	import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
	import type { Feature, FeatureCollection, Polygon } from 'geojson';
	import { cellKey, cellsForBounds, levelCell, levelForBounds } from '$lib/grid';
	import { geoCellDegrees, holdZoom } from '$lib/label-layout';
	import type { Bounds } from '$lib/bounds';

	// The live map instance from <LocationMap> (its style is already loaded — we're only
	// mounted after `load`). Everything is drawn through it as GL sources/layers.
	let { map }: { map: MapLibreMap } = $props();

	// Mirror <LocationMap>'s viewport padding and declutter-cell tuning so the overlay
	// draws EXACTLY the lattices the app uses. These are dev-only copies of the private
	// constants there (BOUNDS_PADDING, NAME_CELL_PX, CELL_ZOOM_THRESHOLD) — if those
	// change, update these to match.
	const BOUNDS_PADDING = 0.2;
	const NAME_CELL_PX = 84;
	const CELL_ZOOM_THRESHOLD = 0.25;

	// Distinct colours per grid so the two lattices read apart at a glance.
	const DATA_COLOR = '#00e5ff'; // data-fetch grid ($lib/grid)
	const DECLUTTER_COLOR = '#ff45d0'; // label-declutter grid ($lib/label-layout)

	// Source ids; each gets a `-fill` and a `-line` layer.
	const DATA_SRC = 'grid-debug-data';
	const DECLUTTER_SRC = 'grid-debug-declutter';

	// A backstop on how many declutter cells we enumerate, so a pathological
	// wide-view/small-cell combination can never spin building millions of polygons.
	const DECLUTTER_CELL_CAP = 4000;

	const EMPTY: FeatureCollection<Polygon> = {
		type: 'FeatureCollection',
		features: []
	};

	// --- Persisted toggles (dev-session convenience) --------------------------
	function loadFlag(key: string, fallback: boolean): boolean {
		try {
			const v = localStorage.getItem(key);
			return v === null ? fallback : v === '1';
		} catch {
			return fallback;
		}
	}

	let showData = $state(loadFlag('gridDebug.data', false));
	let showDeclutter = $state(loadFlag('gridDebug.declutter', false));
	let collapsed = $state(loadFlag('gridDebug.collapsed', false));

	function persist() {
		try {
			localStorage.setItem('gridDebug.data', showData ? '1' : '0');
			localStorage.setItem('gridDebug.declutter', showDeclutter ? '1' : '0');
			localStorage.setItem('gridDebug.collapsed', collapsed ? '1' : '0');
		} catch {
			// localStorage can be unavailable (private mode); toggles just don't persist.
		}
	}

	// --- Live HUD readouts ----------------------------------------------------
	let dataInfo = $state<{ level: number; cellDeg: number; count: number } | null>(null);
	let declutterInfo = $state<{
		cellDeg: number;
		zoom: number;
		count: number;
		capped: boolean;
	} | null>(null);

	// The declutter cell is pinned to a jitter-held zoom, exactly as <LocationMap> does,
	// so a pure pan doesn't resize the lattice under you.
	let cellZoom = 0;

	// The current padded viewport — the same box <LocationMap> reports to the page (so
	// the data-grid level/cells shown here match what actually gets fetched).
	function paddedView(): Bounds {
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

	// A single cell as a closed-ring polygon feature.
	function cellFeature(
		minLng: number,
		minLat: number,
		maxLng: number,
		maxLat: number,
		id: string
	): Feature<Polygon> {
		return {
			type: 'Feature',
			properties: { id },
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[minLng, minLat],
						[maxLng, minLat],
						[maxLng, maxLat],
						[minLng, maxLat],
						[minLng, minLat]
					]
				]
			}
		};
	}

	// The data-fetch grid: the exact cells getMapCells would request for this view.
	function dataFeatures(view: Bounds): {
		features: Feature<Polygon>[];
		level: number;
		cellDeg: number;
	} {
		const level = levelForBounds(view);
		const cell = levelCell(level);
		const cells = cellsForBounds(view, cell);
		const features = cells.map(([i, j]) =>
			cellFeature(
				j * cell - 180,
				i * cell - 90,
				(j + 1) * cell - 180,
				(i + 1) * cell - 90,
				cellKey(i, j)
			)
		);
		return { features, level, cellDeg: cell };
	}

	// The label-declutter grid: square-degree cells sized from the (held) zoom, on the
	// same −180/−90 lattice, clamped to the data domain and capped for safety.
	function declutterFeatures(
		view: Bounds,
		cellDeg: number
	): { features: Feature<Polygon>[]; capped: boolean } {
		const minLat = Math.max(view.minLat, -90);
		const maxLat = Math.min(view.maxLat, 90);
		const minLng = Math.max(view.minLng, -180);
		const maxLng = Math.min(view.maxLng, 180);
		const features: Feature<Polygon>[] = [];
		if (!(cellDeg > 0) || minLat > maxLat || minLng > maxLng) return { features, capped: false };
		const y0 = Math.floor((minLat + 90) / cellDeg);
		const y1 = Math.floor((maxLat + 90) / cellDeg);
		const x0 = Math.floor((minLng + 180) / cellDeg);
		const x1 = Math.floor((maxLng + 180) / cellDeg);
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				if (features.length >= DECLUTTER_CELL_CAP) return { features, capped: true };
				features.push(
					cellFeature(
						x * cellDeg - 180,
						y * cellDeg - 90,
						(x + 1) * cellDeg - 180,
						(y + 1) * cellDeg - 90,
						`${x},${y}`
					)
				);
			}
		}
		return { features, capped: false };
	}

	function setData(id: string, features: Feature<Polygon>[]) {
		const src = map.getSource(id) as GeoJSONSource | undefined;
		src?.setData({ type: 'FeatureCollection', features });
	}

	function setVisible(id: string, on: boolean) {
		for (const suffix of ['-fill', '-line']) {
			if (map.getLayer(id + suffix)) {
				map.setLayoutProperty(id + suffix, 'visibility', on ? 'visible' : 'none');
			}
		}
	}

	// Recompute both lattices for the current camera and push them to the GL sources.
	// MapLibre re-projects the existing geometry every frame, so this only needs to run
	// when the camera moves (new cells scroll in, or a zoom changes the level/cell size).
	function redraw() {
		const view = paddedView();

		if (showData) {
			const { features, level, cellDeg } = dataFeatures(view);
			setData(DATA_SRC, features);
			dataInfo = { level, cellDeg, count: features.length };
			setVisible(DATA_SRC, true);
		} else {
			setVisible(DATA_SRC, false);
			dataInfo = null;
		}

		if (showDeclutter) {
			const zoom = map.getZoom();
			cellZoom = holdZoom(cellZoom, zoom, CELL_ZOOM_THRESHOLD);
			const cellDeg = geoCellDegrees(cellZoom, NAME_CELL_PX);
			const { features, capped } = declutterFeatures(view, cellDeg);
			setData(DECLUTTER_SRC, features);
			declutterInfo = { cellDeg, zoom, count: features.length, capped };
			setVisible(DECLUTTER_SRC, true);
		} else {
			setVisible(DECLUTTER_SRC, false);
			declutterInfo = null;
		}
	}

	function addGrid(id: string, color: string) {
		if (map.getSource(id)) return;
		map.addSource(id, { type: 'geojson', data: EMPTY });
		map.addLayer({
			id: `${id}-fill`,
			type: 'fill',
			source: id,
			layout: { visibility: 'none' },
			paint: { 'fill-color': color, 'fill-opacity': 0.06 }
		});
		map.addLayer({
			id: `${id}-line`,
			type: 'line',
			source: id,
			layout: { visibility: 'none' },
			paint: { 'line-color': color, 'line-width': 1, 'line-opacity': 0.85 }
		});
	}

	function removeGrid(id: string) {
		for (const suffix of ['-fill', '-line']) {
			if (map.getLayer(id + suffix)) map.removeLayer(id + suffix);
		}
		if (map.getSource(id)) map.removeSource(id);
	}

	onMount(() => {
		// <LocationMap> only mounts us once the map's `load` has fired, so the style is
		// parsed and addSource/addLayer are safe here.
		addGrid(DATA_SRC, DATA_COLOR);
		addGrid(DECLUTTER_SRC, DECLUTTER_COLOR);

		const onMove = () => redraw();
		map.on('move', onMove);
		map.on('moveend', onMove);
		redraw();

		return () => {
			map.off('move', onMove);
			map.off('moveend', onMove);
			removeGrid(DATA_SRC);
			removeGrid(DECLUTTER_SRC);
		};
	});

	// Toggle handlers: flip the flag, persist the choice, and redraw. Driven directly
	// from the checkbox/button events (not an $effect) so the imperative GL redraw stays
	// out of the reactive graph.
	function toggleData(on: boolean) {
		showData = on;
		persist();
		redraw();
	}

	function toggleDeclutter(on: boolean) {
		showDeclutter = on;
		persist();
		redraw();
	}

	function toggleCollapsed() {
		collapsed = !collapsed;
		persist();
	}

	// Format a cell's degree span as a human distance (~111 km per degree of latitude).
	function fmtSpan(deg: number): string {
		const km = deg * 111;
		if (km >= 1) return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`;
		return `${Math.round(km * 1000)} m`;
	}

	function fmtDeg(deg: number): string {
		if (deg >= 1) return `${Number(deg.toFixed(2))}°`;
		return `${Number(deg.toPrecision(2))}°`;
	}
</script>

<div class="grid-debug" class:grid-debug--collapsed={collapsed}>
	<button
		type="button"
		class="grid-debug__bar"
		onclick={toggleCollapsed}
		title="Toggle grid debug panel"
	>
		<span class="grid-debug__dot"></span>
		<span class="grid-debug__title">grid debug</span>
		<span class="grid-debug__chevron">{collapsed ? '▸' : '▾'}</span>
	</button>

	{#if !collapsed}
		<div class="grid-debug__body">
			<label class="grid-debug__row">
				<input
					type="checkbox"
					checked={showData}
					onchange={(e) => toggleData(e.currentTarget.checked)}
				/>
				<span class="grid-debug__swatch" style:background={DATA_COLOR}></span>
				<span class="grid-debug__label">data-fetch grid</span>
			</label>
			{#if showData && dataInfo}
				<div class="grid-debug__info">
					level {dataInfo.level} · {fmtDeg(dataInfo.cellDeg)} (~{fmtSpan(dataInfo.cellDeg)}) · {dataInfo.count}
					cells
				</div>
			{/if}

			<label class="grid-debug__row">
				<input
					type="checkbox"
					checked={showDeclutter}
					onchange={(e) => toggleDeclutter(e.currentTarget.checked)}
				/>
				<span class="grid-debug__swatch" style:background={DECLUTTER_COLOR}></span>
				<span class="grid-debug__label">declutter grid</span>
			</label>
			{#if showDeclutter && declutterInfo}
				<div class="grid-debug__info">
					z{declutterInfo.zoom.toFixed(1)} · {fmtDeg(declutterInfo.cellDeg)} (~{NAME_CELL_PX}px) · {declutterInfo.count}{declutterInfo.capped
						? '+'
						: ''} cells
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Top-right, clear of the search (top-left), the zoom control (bottom-left) and the
	   OSM attribution (bottom-right). Dev-only, so it can sit above everything. */
	.grid-debug {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 30;
		width: max-content;
		max-width: 240px;
		font:
			11px/1.4 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		color: #f4f4f5;
		background: rgba(17, 18, 20, 0.86);
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 8px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
		overflow: hidden;
		user-select: none;
	}

	.grid-debug__bar {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		margin: 0;
		padding: 6px 8px;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.grid-debug__dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: linear-gradient(135deg, #00e5ff 0 50%, #ff45d0 50% 100%);
	}

	.grid-debug__title {
		flex: 1;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.grid-debug__chevron {
		opacity: 0.7;
	}

	.grid-debug__body {
		padding: 0 8px 8px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.grid-debug__row {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}

	.grid-debug__row input {
		margin: 0;
		cursor: pointer;
	}

	.grid-debug__swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		border: 1px solid rgba(255, 255, 255, 0.3);
	}

	.grid-debug__label {
		flex: 1;
	}

	.grid-debug__info {
		margin: 0 0 4px 22px;
		opacity: 0.72;
	}
</style>
