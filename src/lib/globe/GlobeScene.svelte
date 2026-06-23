<script lang="ts">
	// The 3D scene that lives inside <Canvas>: the orbiting camera and its controls,
	// the tiled globe, and the location markers. It owns the two jobs that bridge the
	// 3D world back to the app — reporting the visible area (debounced) so the page
	// can load data for it, and flying the camera to a newly-selected location.
	import { untrack } from 'svelte';
	import { T, useThrelte, useTask } from '@threlte/core';
	import { OrbitControls, interactivity } from '@threlte/extras';
	import { Color, PerspectiveCamera, Vector3 } from 'three';
	import TileGlobe from './TileGlobe.svelte';
	import LocationMarkers from './LocationMarkers.svelte';
	import {
		computeView,
		selectZoom,
		padBounds,
		lngLatToVector3,
		slerpCamera,
		rotateSpeedForDistance,
		type Vec3
	} from './geo';
	import * as C from './constants';
	import type { GlobeLocation, GlobeView } from './types';

	let {
		locations,
		selected = null,
		onselect,
		initialCenter = null,
		onviewchange
	}: {
		locations: GlobeLocation[];
		selected?: GlobeLocation | null;
		onselect?: (id: string) => void;
		initialCenter?: [number, number] | null;
		onviewchange?: (view: GlobeView) => void;
	} = $props();

	// Enable raycast pointer events (used by the markers and the globe occluder).
	interactivity();

	const { camera, scene } = useThrelte();
	// A flat "space" backdrop, painted regardless of the canvas's alpha.
	scene.background = new Color(C.SPACE_COLOR);

	// Opening camera position: above the IP-detected centre when available, else the
	// built-in default. Snapshotted once at construction (untracked, like the old
	// map); later changes to initialCenter don't yank the camera — only selecting a
	// place moves it.
	const openCenter = untrack(() => initialCenter) ?? C.DEFAULT_CENTER; // [lat, lng]
	const openVec = lngLatToVector3(openCenter[1], openCenter[0], C.DEFAULT_CAMERA_DISTANCE);
	const initialPosition: [number, number, number] = [openVec.x, openVec.y, openVec.z];

	// The settled viewport handed to the tile layer (and reported to the parent).
	let view = $state<GlobeView | null>(null);

	// Active fly-to target (a camera position), or null when at rest.
	let flyTarget = $state<Vec3 | null>(null);
	let lastSelectedId: string | null = null;

	// Settle detection: report once the camera has been still for the debounce
	// window. Frame-driven (renderMode="always"), so no timers are needed.
	let lastPos: Vector3 | null = null;
	let needsReport = true;
	let idleSeconds = 0;

	// Current camera distance, tracked so drag sensitivity can follow the zoom.
	// Only rotation/zoom move the camera, so this updates during zoom and stays put
	// during a rotate drag — keeping the speed fixed for the duration of a drag.
	let cameraDistance = $state(C.DEFAULT_CAMERA_DISTANCE);
	const rotateSpeed = $derived(
		Math.min(
			C.MAX_ROTATE_SPEED,
			Math.max(C.MIN_ROTATE_SPEED, rotateSpeedForDistance(cameraDistance, C.CAMERA_FOV))
		)
	);

	function report(): void {
		const cam = camera.current;
		if (!(cam instanceof PerspectiveCamera)) return;
		const position = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
		const model = computeView({ cameraPosition: position, fovDeg: cam.fov, aspect: cam.aspect });
		const zoom = selectZoom(model.lngSpanDeg, {
			tilesAcross: C.TILES_ACROSS,
			minZoom: C.MIN_DETAIL_ZOOM,
			maxZoom: C.MAX_DETAIL_ZOOM
		});
		const next: GlobeView = { bounds: padBounds(model.bounds, C.BOUNDS_PADDING), zoom };
		view = next;
		onviewchange?.(next);
	}

	useTask((delta) => {
		const cam = camera.current;
		if (!cam) return;

		// Track distance so drag sensitivity follows the zoom. Update only on a
		// meaningful change to avoid per-frame reactive churn while at rest.
		const distance = cam.position.length();
		if (Math.abs(distance - cameraDistance) > 1e-4) cameraDistance = distance;

		// Ease the camera toward the fly target: the direction slerps over the
		// surface while the distance interpolates, a fixed fraction of the remaining
		// arc each frame (frame-rate independent via the delta-based factor).
		if (flyTarget) {
			const t = 1 - Math.exp(-C.FLY_RATE * delta);
			const cur = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
			const stepped = slerpCamera(cur, flyTarget, t);
			cam.position.set(stepped.x, stepped.y, stepped.z);
			cam.lookAt(0, 0, 0);
			const dx = cam.position.x - flyTarget.x;
			const dy = cam.position.y - flyTarget.y;
			const dz = cam.position.z - flyTarget.z;
			if (dx * dx + dy * dy + dz * dz < 1e-6) {
				cam.position.set(flyTarget.x, flyTarget.y, flyTarget.z);
				cam.lookAt(0, 0, 0);
				flyTarget = null;
			}
		}

		if (!lastPos) lastPos = new Vector3().copy(cam.position);
		const moved = cam.position.distanceToSquared(lastPos) > 1e-10;
		lastPos.copy(cam.position);
		if (moved) {
			needsReport = true;
			idleSeconds = 0;
		} else if (needsReport) {
			idleSeconds += delta;
			if (idleSeconds >= C.VIEW_DEBOUNCE_MS / 1000) {
				report();
				needsReport = false;
				idleSeconds = 0;
			}
		}
	});

	// Fly to a location when the selection changes to a new one. Guarded by
	// lastSelectedId so a marker re-render (e.g. a viewport refetch) doesn't re-fly
	// to an already-open place — only an actual change of selection moves the camera.
	$effect(() => {
		const id = selected?.id ?? null;
		if (id && id !== lastSelectedId && selected) {
			flyTarget = lngLatToVector3(
				selected.longitude,
				selected.latitude,
				C.SELECTED_CAMERA_DISTANCE
			);
		}
		lastSelectedId = id;
	});
</script>

<T.PerspectiveCamera
	makeDefault
	fov={C.CAMERA_FOV}
	near={C.CAMERA_NEAR}
	far={C.CAMERA_FAR}
	position={initialPosition}
>
	<!-- Orbit the globe centre; no panning (the globe stays framed) and zoom is
	     clamped between just-above-the-surface and the whole-globe view. rotateSpeed
	     tracks the zoom so a drag keeps the grabbed point under the cursor. -->
	<OrbitControls
		enableDamping
		dampingFactor={0.08}
		enablePan={false}
		minDistance={C.MIN_CAMERA_DISTANCE}
		maxDistance={C.MAX_CAMERA_DISTANCE}
		{rotateSpeed}
		zoomSpeed={0.8}
	/>
</T.PerspectiveCamera>

<TileGlobe {view} />
<LocationMarkers {locations} {selected} {onselect} />
