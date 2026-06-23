<script lang="ts">
	// Location pins as true 3D scene objects: one instanced sphere per location,
	// raycast for hover/click via Threlte's interactivity plugin (set up by the
	// parent scene). Hovering anchors a small HTML tooltip at the marker's 3D point;
	// clicking selects the location (the same action as a result card). The selected
	// marker is drawn larger and in the accent-hover colour, and is shown even when
	// it falls outside the in-view set (e.g. opened from a shared link).
	import { T, useThrelte, useTask } from '@threlte/core';
	import { HTML, InstancedMesh, Instance } from '@threlte/extras';
	import { Color } from 'three';
	import { categoryLabel } from '$lib/category';
	import { lngLatToVector3, GLOBE_RADIUS } from './geo';
	import * as C from './constants';
	import type { GlobeLocation } from './types';

	let {
		locations,
		selected = null,
		onselect
	}: {
		locations: GlobeLocation[];
		selected?: GlobeLocation | null;
		onselect?: (id: string) => void;
	} = $props();

	const { camera } = useThrelte();

	// Shared colour instances (read-only) so each Instance doesn't allocate one.
	const baseColor = new Color(C.MARKER_COLOR);
	const selectedColor = new Color(C.MARKER_SELECTED_COLOR);
	const markerRadius = GLOBE_RADIUS * (1 + C.MARKER_ALTITUDE);

	// Plot every in-view location, plus the selected one when it's not among them.
	const renderList = $derived.by(() => {
		const list = [...locations];
		if (selected && !list.some((loc) => loc.id === selected.id)) list.push(selected);
		return list;
	});
	const byId = $derived(new Map(renderList.map((loc) => [loc.id, loc])));

	function markerPosition(loc: GlobeLocation): [number, number, number] {
		const p = lngLatToVector3(loc.longitude, loc.latitude, markerRadius);
		return [p.x, p.y, p.z];
	}

	let hoveredId = $state<string | null>(null);
	// On-screen marker size, kept roughly steady by scaling with camera distance;
	// updated only when it drifts enough to matter, so resting frames don't churn.
	let markerScale = $state(1);
	// Whether the hovered marker is on the near hemisphere — the tooltip is hidden
	// for a marker that has rotated to the far side (belt-and-braces with the
	// globe's raycast occluder).
	let tooltipVisible = $state(false);

	const hovered = $derived(hoveredId === null ? null : (byId.get(hoveredId) ?? null));

	useTask(() => {
		const cam = camera.current;
		if (!cam) return;

		const distance = cam.position.length();
		const targetScale = Math.min(
			C.MARKER_MAX_SCALE,
			Math.max(C.MARKER_MIN_SCALE, distance / C.DEFAULT_CAMERA_DISTANCE)
		);
		if (Math.abs(targetScale - markerScale) / markerScale > 0.02) markerScale = targetScale;

		// Near-hemisphere test: a unit surface point P is visible when
		// dot(P, cameraDir) > R/|camera|. Hide the tooltip otherwise.
		const loc = hoveredId === null ? null : byId.get(hoveredId);
		if (loc) {
			const dir = lngLatToVector3(loc.longitude, loc.latitude, 1);
			const cos =
				(dir.x * cam.position.x + dir.y * cam.position.y + dir.z * cam.position.z) / distance;
			const visible = cos > 1 / distance + 1e-3;
			if (visible !== tooltipVisible) tooltipVisible = visible;
		} else if (tooltipVisible) {
			tooltipVisible = false;
		}
	});

	function handleEnter(id: string): void {
		hoveredId = id;
	}
	function handleLeave(id: string): void {
		if (hoveredId === id) hoveredId = null;
	}
	function handleClick(event: { stopPropagation: () => void }, id: string): void {
		// Don't let the click fall through to the globe behind the marker.
		event.stopPropagation();
		onselect?.(id);
	}
</script>

<InstancedMesh limit={C.MARKER_INSTANCE_LIMIT} range={renderList.length}>
	<T.SphereGeometry args={[C.MARKER_BASE_RADIUS, 16, 16]} />
	<!-- Unlit: instance colours show directly and pins stay readable from any angle. -->
	<T.MeshBasicMaterial />

	{#each renderList as loc (loc.id)}
		{@const isSelected = selected?.id === loc.id}
		<Instance
			position={markerPosition(loc)}
			scale={(isSelected ? C.MARKER_SELECTED_SCALE : 1) * markerScale}
			color={isSelected ? selectedColor : baseColor}
			onpointerenter={() => handleEnter(loc.id)}
			onpointerleave={() => handleLeave(loc.id)}
			onclick={(event: { stopPropagation: () => void }) => handleClick(event, loc.id)}
		/>
	{/each}
</InstancedMesh>

{#if hovered && tooltipVisible}
	{@const label = categoryLabel(hovered.category)}
	<HTML position={markerPosition(hovered)} center>
		<div class="tip">
			<strong class="tip__name">{hovered.name}</strong>
			{#if label}<span class="tip__line">{label}</span>{/if}
			{#if hovered.address}<span class="tip__line">{hovered.address}</span>{/if}
		</div>
	</HTML>
{/if}

<style>
	/* The tooltip floats at the marker; it must never intercept pointer events, or
	   it would steal the hover that keeps it open. */
	.tip {
		transform: translateY(-1.6rem);
		pointer-events: none;
		white-space: nowrap;
		text-align: center;
		padding: 0.3rem 0.55rem;
		border-radius: 0.5rem;
		background: rgba(255, 255, 255, 0.92);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
		font-size: 0.78rem;
		line-height: 1.3;
		color: var(--color-text);
	}

	.tip__name {
		display: block;
		font-weight: 700;
	}

	.tip__line {
		display: block;
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}
</style>
