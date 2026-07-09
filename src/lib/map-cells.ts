// Slicing and re-assembly of per-cell map payloads. A getMapCells response (see
// {@link MapCellsData}) is a plain MapData plus the `cells` record saying which
// locations belong to which requested cell — these helpers split it into
// self-contained per-cell slices (what both the client store and the server's
// per-cell cache hold) and merge slices back into the MapData the page renders.
// Client-safe: the db import is type-only, so nothing server-side reaches the
// browser bundle.

import type { MapCellsData, MapData, MapItem, MapLocation } from '$lib/server/db';

/**
 * One cell's worth of map data, self-contained: the cell's locations plus the
 * menus (and their metadata) those locations reference. A chain's shared menu
 * is duplicated across the slices of every cell holding one of its branches —
 * deliberate: it keeps each slice independently cacheable, and the duplication
 * collapses again when slices are merged for the wire or the page.
 */
export interface CellSlice {
	locations: MapLocation[];
	menus: Record<string, MapItem[]>;
	menuMeta: MapData['menuMeta'];
}

/**
 * Splits a cells payload into one {@link CellSlice} per REQUESTED cell — an
 * empty cell yields an empty slice (the negative entry that stops it being
 * re-fetched). Inverse of {@link assembleCellsData} (modulo ordering and menu
 * de-duplication).
 */
export function splitCellSlices(data: MapCellsData): Map<string, CellSlice> {
	const locById = new Map(data.locations.map((loc) => [loc.id, loc]));
	const slices = new Map<string, CellSlice>();
	for (const [key, ids] of Object.entries(data.cells)) {
		const locations: MapLocation[] = [];
		const menus: CellSlice['menus'] = {};
		const menuMeta: CellSlice['menuMeta'] = {};
		for (const id of ids) {
			const loc = locById.get(id);
			if (!loc) continue;
			locations.push(loc);
			if (loc.menu_id !== null) {
				// Copied independently: a menu with zero items has a menuMeta entry
				// (the menus-table read) but no menus entry (built from item rows),
				// and its "Verified" date must survive the slicing all the same.
				if (data.menus[loc.menu_id] !== undefined) menus[loc.menu_id] = data.menus[loc.menu_id];
				if (data.menuMeta[loc.menu_id] !== undefined)
					menuMeta[loc.menu_id] = data.menuMeta[loc.menu_id];
			}
		}
		slices.set(key, { locations, menus, menuMeta });
	}
	return slices;
}

/**
 * Merges cell slices into the {@link MapData} the page renders. A shared menu
 * carried by several slices collapses back to one entry under its menu_id,
 * and locations are de-duplicated by id: within ONE data snapshot the lattice
 * partitions venues across cells, but the merge inputs can mix slices banked
 * at different times — the client CellStore holds entries fetched across a
 * TTL window, and the server cell-cache merges cached blocks with fresh D1
 * reads in one response — so a venue whose cell assignment changed (e.g. a
 * coordinate fix moved it across a cell boundary) can appear in two slices.
 * A duplicate row would corrupt the page's keyed `{#each … (loc.id)}`.
 * Slice order encodes CELL order, not freshness (cached and fresh slices
 * interleave in both merge paths), so no occurrence is knowably newer; we
 * keep the last one — either copy is at most one cache TTL stale.
 */
export function mergeCellSlices(slices: Iterable<CellSlice>): MapData {
	const merged: MapData = { locations: [], menus: {}, menuMeta: {} };
	const locById = new Map<MapLocation['id'], MapLocation>();
	for (const slice of slices) {
		for (const loc of slice.locations) locById.set(loc.id, loc);
		Object.assign(merged.menus, slice.menus);
		Object.assign(merged.menuMeta, slice.menuMeta);
	}
	merged.locations = [...locById.values()];
	return merged;
}

/** Re-assembles keyed slices into the wire shape ({@link MapCellsData}). */
export function assembleCellsData(slices: Map<string, CellSlice>): MapCellsData {
	const cells: MapCellsData['cells'] = {};
	for (const [key, slice] of slices) cells[key] = slice.locations.map((loc) => loc.id);
	return { ...mergeCellSlices(slices.values()), cells };
}
