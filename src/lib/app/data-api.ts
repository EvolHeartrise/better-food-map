// App shim for `$lib/data.remote` (aliased in the Capacitor build — see
// vite.config.ts). Same export surface the web components import, backed by the
// /api/v1 endpoints that share the remote functions' schemas + handlers.
import type { Item, MapData, MapCellsData, MapStats } from '$lib/server/db';
import { apiGet } from './api-client';
import { makeQuery, makeArgQuery } from './query-resource.svelte';

/**
 * The per-cell viewport fetch (mirrors getMapCells). Called directly by
 * ViewportData as a plain `(args) => Promise<MapCellsData>` — no resource
 * wrapper, since ViewportData does its own cell-store dedup and in-flight
 * bookkeeping, and memoizing on the (large, ever-changing) cell set would leak.
 * `cells` is flattened to the comma-separated i,j pair list the endpoint decodes.
 */
export function getMapCells(args: {
	level: number;
	cells: [number, number][];
	q: string;
	diet: string | null;
}): Promise<MapCellsData> {
	const params = new URLSearchParams();
	params.set('level', String(args.level));
	params.set('cells', args.cells.flat().join(','));
	if (args.q) params.set('q', args.q);
	if (args.diet !== null) params.set('diet', args.diet);
	return apiGet<MapCellsData>(`/api/v1/map-cells?${params.toString()}`);
}

/** A single location's full detail (mirrors getLocationData); deduped per id. */
export const getLocationData = makeArgQuery((id: string) =>
	apiGet<MapData<Item>>(`/api/v1/locations/${encodeURIComponent(id)}`)
);

/** Aggregate coverage totals for the landing overlay (mirrors getStats). */
export const getStats = makeQuery(() => apiGet<MapStats>('/api/v1/stats'));

/** Best-effort IP-derived opening location (mirrors getUserLocation). */
export const getUserLocation = makeQuery(() =>
	apiGet<{ lat: number; lng: number } | null>('/api/v1/user-location')
);
