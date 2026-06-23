<script lang="ts">
	// The globe surface: an opaque base sphere (ocean colour, also showing through
	// at the poles where Mercator tiles can't reach), a fixed low-zoom tile layer
	// blanketing the whole world, and a higher-zoom detail layer that refreshes to
	// cover the current viewport. The two tile layers are managed imperatively by
	// TileLayer; this component just feeds them tile sets and owns their lifecycle.
	import { T, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { TileLayer } from './tile-layer';
	import { tilesInBounds, GLOBE_RADIUS, MERCATOR_MAX_LAT } from './geo';
	import * as C from './constants';
	import type { GlobeView } from './types';

	// The settled viewport (padded bounds + chosen slippy zoom), or null until the
	// scene has reported its opening view.
	let { view }: { view: GlobeView | null } = $props();

	// With renderMode="always" frames are continuous, but wiring invalidate() keeps
	// the layers correct even if the render mode is later switched to on-demand.
	const { invalidate } = useThrelte();

	const baseLayer = new TileLayer({
		radius: GLOBE_RADIUS,
		segments: C.tileSegments,
		altitude: C.BASE_TILE_ALTITUDE,
		tileUrl: C.osmTileUrl,
		onUpdate: invalidate
	});
	const detailLayer = new TileLayer({
		radius: GLOBE_RADIUS,
		segments: C.tileSegments,
		altitude: C.DETAIL_TILE_ALTITUDE,
		tileUrl: C.osmTileUrl,
		onUpdate: invalidate
	});

	// The base layer covers the whole Mercator world once; it never changes.
	baseLayer.setTiles(
		tilesInBounds(
			{ minLat: -MERCATOR_MAX_LAT, maxLat: MERCATOR_MAX_LAT, minLng: -180, maxLng: 180 },
			C.BASE_TILE_ZOOM,
			999
		)
	);

	// Refresh the detail layer to cover the current viewport whenever it settles.
	$effect(() => {
		if (!view) return;
		detailLayer.setTiles(tilesInBounds(view.bounds, view.zoom, C.MAX_DETAIL_TILES));
	});

	// Pointer handler on the base sphere: swallowing the event makes the opaque
	// globe an occluder for the interactivity raycaster, so markers on the far side
	// can't be hovered or clicked "through" the planet.
	function occlude(event: { stopPropagation: () => void }): void {
		event.stopPropagation();
	}

	onDestroy(() => {
		baseLayer.dispose();
		detailLayer.dispose();
	});
</script>

<!-- Opaque base sphere: the ocean/poles fallback and the raycast occluder. -->
<T.Mesh onpointermove={occlude} onclick={occlude}>
	<T.SphereGeometry args={[GLOBE_RADIUS, 64, 48]} />
	<T.MeshBasicMaterial color={C.OCEAN_COLOR} />
</T.Mesh>

<!-- Draped OSM tiles. Each layer's group is built and updated by its TileLayer. -->
<T is={baseLayer.group} />
<T is={detailLayer.group} />
