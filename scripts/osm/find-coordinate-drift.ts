// ---------------------------------------------------------------------------
// find_coordinate_drift: audit existing locations against the local OSM POI
// staging store and surface any whose stored coordinates do NOT coincide with
// their OpenStreetMap POI.
//
// Coordinates must be OSM-sourced and passed through verbatim (see CLAUDE.md
// "Location coordinates must be OSM-based"), so a healthy location sits ~0 m from
// its staging POI. Anything farther has DRIFTED and can be snapped back with
// update_location using the returned osm_* fields. Locations with no name-matching
// OSM POI nearby have no counterpart to align to and are reported separately.
//
// Like search_poi, the only non-deterministic input is the single D1 read; the
// matching itself is offline against the staging store.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { osmUrl } from './map-feature';
import type { OsmPoiStore } from './poi-store';
import { LOCATION_AUDIT, nearestNameMatch } from './poi-match';

export interface FindDriftParams {
	/** Max mismatched locations to return (default 50, max 200). */
	limit?: number;
	/** A location is OSM-aligned when a name-matching POI sits within this many metres (default 1). */
	tolerance_m?: number;
	/**
	 * How far to look for a name-matching OSM POI before reporting no match
	 * (default 250, max 50000). Kept modest so a "drifted" hit is a confidently-same
	 * venue; widen it to hunt for relocated/far matches, but then sanity-check
	 * `distance_m` — a large match may be a different branch of a multi-site brand.
	 */
	search_radius_m?: number;
	/** Also report locations with no name-matching OSM POI nearby (default true). */
	include_unmatched?: boolean;
}

export interface DriftLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	/** 'drifted' = a name-matching OSM POI exists but coords differ; 'no_osm_match' = none found nearby. */
	classification: 'drifted' | 'no_osm_match';
	/** Metres from the stored point to the matched OSM POI (drifted only). */
	distance_m?: number;
	/** The matched OSM POI, ready to snap to via update_location (drifted only). */
	osm_url?: string;
	osm_latitude?: number;
	osm_longitude?: number;
	matched_osm_name?: string | null;
}

export interface FindDriftResult {
	mismatches: DriftLocation[];
	/** Total DB locations scanned. */
	scanned: number;
	/** Total mismatches in scope (drifted, plus unmatched when include_unmatched). */
	total_mismatches: number;
	/** How many of those are in `mismatches`. */
	returned: number;
	/** Mismatches NOT returned because of `limit` (total_mismatches - returned). */
	additional: number;
	/** Full breakdown of what was found, regardless of include_unmatched. */
	counts: { drifted: number; no_osm_match: number };
}

const { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M } = LOCATION_AUDIT;
const DEFAULT_TOLERANCE_M = 1;

interface LocationRow {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
}

async function allLocations(db: D1Like): Promise<LocationRow[]> {
	const { results } = await db
		.prepare('SELECT id, name, latitude, longitude FROM locations')
		.all<LocationRow>();
	return results;
}

/**
 * Scans every location and finds the nearest OSM staging POI that NAME-matches it
 * (same normalisation/containment rule as search_poi's dedup). A location is a
 * mismatch when that nearest match is farther than `tolerance_m` (it has drifted)
 * or when no name-match exists within `search_radius_m` (`no_osm_match`).
 *
 * Returns worst-drift-first so the `limit` window surfaces the most suspicious
 * coordinates, with `additional` reporting how many more were found.
 */
export async function findCoordinateDrift(
	store: OsmPoiStore,
	db: D1Like,
	params: FindDriftParams
): Promise<FindDriftResult> {
	const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	const tolerance = Math.max(0, params.tolerance_m ?? DEFAULT_TOLERANCE_M);
	const searchRadiusKm =
		Math.min(Math.max(0, params.search_radius_m ?? DEFAULT_SEARCH_RADIUS_M), MAX_SEARCH_RADIUS_M) /
		1000;
	const includeUnmatched = params.include_unmatched ?? true;

	const locations = await allLocations(db);
	const drifted: DriftLocation[] = [];
	const unmatched: DriftLocation[] = [];

	for (const loc of locations) {
		const best = nearestNameMatch(store, loc, searchRadiusKm);

		if (!best) {
			unmatched.push({
				id: loc.id,
				name: loc.name,
				latitude: loc.latitude,
				longitude: loc.longitude,
				classification: 'no_osm_match'
			});
			continue;
		}
		if (best.dist <= tolerance) continue; // aligned — not a mismatch

		drifted.push({
			id: loc.id,
			name: loc.name,
			latitude: loc.latitude,
			longitude: loc.longitude,
			classification: 'drifted',
			distance_m: Math.round(best.dist),
			osm_url: osmUrl(best.poi.osm_type, best.poi.numeric_id),
			osm_latitude: best.poi.latitude,
			osm_longitude: best.poi.longitude,
			matched_osm_name: best.poi.name
		});
	}

	// Worst drift first (most suspicious), then the unmatched tail when included.
	drifted.sort((a, b) => (b.distance_m ?? 0) - (a.distance_m ?? 0));
	const ordered = includeUnmatched ? [...drifted, ...unmatched] : drifted;

	const total = ordered.length;
	const mismatches = ordered.slice(0, limit);
	return {
		mismatches,
		scanned: locations.length,
		total_mismatches: total,
		returned: mismatches.length,
		additional: total - mismatches.length,
		counts: { drifted: drifted.length, no_osm_match: unmatched.length }
	};
}
