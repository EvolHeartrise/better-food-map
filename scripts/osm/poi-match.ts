// ---------------------------------------------------------------------------
// Shared matching helper for the location-audit tools (find_coordinate_drift and
// find_missing_address). Both walk every existing location and align it to the
// OSM staging POI it was — or should have been — sourced from: the nearest POI
// nearby whose name matches (same normalisation/containment rule as search_poi's
// dedup). Pure/offline against the staging store; the D1 read lives in the callers.
// ---------------------------------------------------------------------------

import { bboxAround, haversineMeters } from './geo';
import { normalizeName, namesMatch } from './search-poi';
import type { OsmPoiStore, StoredPoi } from './poi-store';

/** Defaults/caps shared by both location-audit tools (a location is OSM-sourced, so its POI sits ~0 m away). */
export const LOCATION_AUDIT = {
	DEFAULT_LIMIT: 50,
	MAX_LIMIT: 200,
	DEFAULT_SEARCH_RADIUS_M: 250,
	MAX_SEARCH_RADIUS_M: 50000,
	/** Max staging candidates pulled per location before name-filtering. */
	PER_LOCATION_CANDIDATE_CAP: 500
} as const;

/** A named, located record (a DB location row) to align against the staging store. */
export interface NamedPoint {
	name: string;
	latitude: number;
	longitude: number;
}

/**
 * Finds the nearest OSM staging POI that name-matches `loc` within `searchRadiusKm`,
 * or null when none is found. The match rule (normalised name equality/containment)
 * is search_poi's dedup rule, so an OSM-sourced location aligns to its own POI.
 */
export function nearestNameMatch(
	store: OsmPoiStore,
	loc: NamedPoint,
	searchRadiusKm: number
): { poi: StoredPoi; dist: number } | null {
	const bbox = bboxAround(loc.latitude, loc.longitude, searchRadiusKm);
	const candidates = store.searchBbox(bbox, { cap: LOCATION_AUDIT.PER_LOCATION_CANDIDATE_CAP });
	const locName = normalizeName(loc.name);

	let best: { poi: StoredPoi; dist: number } | null = null;
	for (const poi of candidates) {
		if (!namesMatch(locName, normalizeName(poi.name))) continue;
		const dist = haversineMeters(loc.latitude, loc.longitude, poi.latitude, poi.longitude);
		if (!best || dist < best.dist) best = { poi, dist };
	}
	return best;
}
