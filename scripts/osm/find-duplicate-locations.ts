// ---------------------------------------------------------------------------
// duplicate_locations audit: pairs of live map locations that are probably ONE
// venue stored twice.
//
// Coordinate-exact dedup (create_locations) can only catch a re-import of the
// SAME OSM POI. When OSM itself carries two stale nodes for one venue — a 2013
// node and a 2020 re-survey a few metres apart — both import "cleanly" and the
// map gets two pins. This audit finds them after the fact: same-name (or
// same-brand) pairs within a small radius, nearest-first, so the worst
// offenders (metres apart) top the work-list. Each pair needs human/agent
// verification against the venue's own locator before delete_location — two
// real branches CAN sit close (food court + street level).
//
// Reads only the live D1 (no OSM store). Unit-tested in
// find-duplicate-locations.test.ts against the real migration schema.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { SpatialGrid, haversineMeters } from './geo';
import { namesMatch, normalizeName } from './search-poi';

/** One location's identity within a flagged pair. */
export interface DuplicateHalf {
	id: string;
	name: string;
	brand_id: string | null;
	latitude: number;
	longitude: number;
	street: string;
	city: string;
}

export interface DuplicatePair {
	/** Metres between the two points (the sort key — closest pairs first). */
	distance_m: number;
	/** True when the two names match after normalization. */
	names_match: boolean;
	/** True when both carry the same non-null brand_id. */
	same_brand: boolean;
	a: DuplicateHalf;
	b: DuplicateHalf;
}

export interface FindDuplicateLocationsResult {
	pairs: DuplicatePair[];
	/** Flagged pairs beyond `limit`. */
	additional: number;
	/** Open locations examined. */
	scanned: number;
	radius_m: number;
}

const DEFAULT_RADIUS_M = 150;
const DEFAULT_LIMIT = 50;
// Grid cells comfortably larger than any plausible radius (≤1 km), so a probe
// touches at most a 3×3 neighbourhood.
const CELL_DEG = 0.02;

/**
 * Flags every pair of OPEN locations within `radius_m` of each other whose
 * names match (normalized) or that share a brand. Nearest pairs first;
 * `limit` caps the returned list with the remainder counted in `additional`.
 */
export async function findDuplicateLocations(
	db: D1Like,
	opts: { radius_m?: number; limit?: number } = {}
): Promise<FindDuplicateLocationsResult> {
	const radiusM = opts.radius_m ?? DEFAULT_RADIUS_M;
	const limit = opts.limit ?? DEFAULT_LIMIT;

	const { results: locations } = await db
		.prepare(
			`SELECT id, name, brand_id, latitude, longitude, street, city
			 FROM locations WHERE closed_at IS NULL`
		)
		.all<DuplicateHalf>();

	const grid = new SpatialGrid(CELL_DEG);
	locations.forEach((loc, i) => grid.insert(i, loc.latitude, loc.longitude));
	const normalized = locations.map((loc) => normalizeName(loc.name));

	// Degrees generously covering radius_m at any inhabited latitude (cos 75° ≈ 0.26);
	// exact haversine refines below, so over-probing only costs a few comparisons.
	const padDeg = (radiusM / 111_320) * 4;

	const pairs: DuplicatePair[] = [];
	locations.forEach((a, i) => {
		for (const j of grid.candidatesInBbox({
			minLat: a.latitude - padDeg,
			maxLat: a.latitude + padDeg,
			minLon: a.longitude - padDeg,
			maxLon: a.longitude + padDeg
		})) {
			if (j <= i) continue; // each unordered pair once
			const b = locations[j];
			const distance = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
			if (distance > radiusM) continue;
			const nameHit = namesMatch(normalized[i], normalized[j]);
			const brandHit = Boolean(a.brand_id) && a.brand_id === b.brand_id;
			if (!nameHit && !brandHit) continue;
			pairs.push({
				distance_m: Math.round(distance),
				names_match: nameHit,
				same_brand: brandHit,
				a,
				b
			});
		}
	});

	pairs.sort((x, y) => x.distance_m - y.distance_m);
	return {
		pairs: pairs.slice(0, limit),
		additional: Math.max(0, pairs.length - limit),
		scanned: locations.length,
		radius_m: radiusM
	};
}
