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
 * Merges cell slices into the {@link MapData} the page renders. Locations
 * simply concatenate — within one level the lattice partitions venues, so no
 * venue appears in two slices — and a shared menu carried by several slices
 * collapses back to one entry under its menu_id.
 */
export function mergeCellSlices(slices: Iterable<CellSlice>): MapData {
	const merged: MapData = { locations: [], menus: {}, menuMeta: {} };
	for (const slice of slices) {
		merged.locations.push(...slice.locations);
		Object.assign(merged.menus, slice.menus);
		Object.assign(merged.menuMeta, slice.menuMeta);
	}
	return merged;
}

/** Re-assembles keyed slices into the wire shape ({@link MapCellsData}). */
export function assembleCellsData(slices: Map<string, CellSlice>): MapCellsData {
	const cells: MapCellsData['cells'] = {};
	for (const [key, slice] of slices) cells[key] = slice.locations.map((loc) => loc.id);
	return { ...mergeCellSlices(slices.values()), cells };
}
