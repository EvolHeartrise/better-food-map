<script lang="ts">
	// Public boundary for the globe renderer — a drop-in replacement for the old
	// MapLibre <LocationMap>, with the same prop contract so the page is unchanged
	// apart from the import. It hosts the Threlte <Canvas> (client-only) and the OSM
	// attribution overlay; all of the 3D work lives in <GlobeScene> and its children.
	import { Canvas } from '@threlte/core';
	import { NoToneMapping } from 'three';
	import { onMount } from 'svelte';
	import GlobeScene from './GlobeScene.svelte';
	import * as C from './constants';
	import type { GlobeLocation, GlobeView } from './types';

	let {
		locations,
		// The currently selected location, shown zoomed-in with its detail panel open
		// on the page. When set, the camera flies to it once and its marker stays
		// visible even if it isn't among the in-view `locations`.
		selected = null,
		// Called with a location id when the user clicks a marker, so the parent can
		// open that location (the same action as clicking a result card).
		onselect,
		// Where the globe opens, as `[lat, lng]` — typically the visitor's IP-detected
		// location. Falls back to DEFAULT_CENTER when absent. The camera otherwise only
		// moves when the user drags/zooms or selects a place.
		initialCenter = null,
		// Called (debounced) with the visible bounding box and zoom whenever the globe
		// settles after a drag/zoom, plus once on load. The parent fetches location
		// data for this box, so only what's on screen is ever loaded.
		onviewchange
	}: {
		locations: GlobeLocation[];
		selected?: GlobeLocation | null;
		onselect?: (id: string) => void;
		initialCenter?: [number, number] | null;
		onviewchange?: (view: GlobeView) => void;
	} = $props();

	// three.js needs WebGL, so the <Canvas> is mounted only in the browser — never
	// during SSR. Gating on a mounted flag (rather than `browser`) also ensures the
	// container has laid out, so the canvas picks up a real size on first paint.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
</script>

<div class="globe" role="application" aria-label="Globe of food locations">
	{#if mounted}
		<!-- Threlte defaults to AgX tone mapping, which crushes the contrast of the
		     flat OSM imagery; the globe is unlit sRGB tiles, so no tone mapping shows
		     them at their true colour. -->
		<Canvas renderMode="always" toneMapping={NoToneMapping}>
			<GlobeScene {locations} {selected} {onselect} {initialCenter} {onviewchange} />
		</Canvas>
	{/if}

	<!-- OSM's tile policy / ODbL require this attribution. The string is a fixed,
	     app-controlled constant, hence the @html. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div class="globe__attribution">{@html C.OSM_ATTRIBUTION_HTML}</div>
</div>

<style>
	.globe {
		position: relative;
		height: 100%;
		width: 100%;
		/* Matches the scene background so there's no flash before the canvas paints. */
		background: var(--globe-space, #070b14);
		overflow: hidden;
		cursor: grab;
	}

	.globe :global(canvas) {
		display: block;
		touch-action: none;
	}

	.globe__attribution {
		position: absolute;
		right: env(safe-area-inset-right);
		bottom: env(safe-area-inset-bottom);
		z-index: 1;
		padding: 0.1rem 0.4rem;
		font-size: 0.65rem;
		line-height: 1.4;
		color: var(--color-text);
		background: rgba(255, 255, 255, 0.7);
		border-top-left-radius: 0.35rem;
	}

	.globe__attribution :global(a) {
		color: var(--color-accent);
	}
</style>
