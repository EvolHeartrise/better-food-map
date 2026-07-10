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
// verification against the venue's own locator before delete_locations — two
// real branches CAN sit close (food court + street level).
//
// Reads only the live D1 (no OSM store). Unit-tested in
// find-duplicate-locations.test.ts against the real migration schema.
// ---------------------------------------------------------------------------

import { type D1Like } from '../../src/lib/server/db';
import { orderedPair } from '../../src/lib/server/db-write';
import { DismissFilter, type DismissableFinding, type DismissalOpts } from './audit-dismiss';
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
	postcode: string | null;
	phone: string | null;
	website: string | null;
}

export interface DuplicatePair extends DismissableFinding {
	/** Metres between the two points (the sort key — closest pairs first). */
	distance_m: number;
	/** True when the two names match after normalization. */
	names_match: boolean;
	/** True when both carry the same non-null brand_id. */
	same_brand: boolean;
	/** True when both carry the same non-null phone (digits compared) — strong same-store evidence. */
	same_phone: boolean;
	/**
	 * "high" = almost certainly one venue stored twice (matching names within
	 * ~30 m, or a shared phone number) — verify against the venue's own locator,
	 * then delete_locations the half with the weaker address. "review" = plausible
	 * but needs judgment (two real branches can sit this close).
	 */
	confidence: 'high' | 'review';
	a: DuplicateHalf;
	b: DuplicateHalf;
}

export interface FindDuplicateLocationsResult {
	pairs: DuplicatePair[];
	/** Flagged pairs beyond `limit`. */
	additional: number;
	/**
	 * Pairs that WOULD have been flagged but carry a dismissal
	 * (dismiss_audit_finding) — verified as two real venues, so not re-flagged
	 * (annotated instead of dropped under include_dismissed).
	 */
	suppressed_dismissed: number;
	/** Open locations examined. */
	scanned: number;
	radius_m: number;
}

const DEFAULT_RADIUS_M = 150;
const DEFAULT_LIMIT = 50;
// Pairs closer than this with matching names are near-certain double-mappings —
// two real branches of one chain essentially never share a wall.
const HIGH_CONFIDENCE_M = 30;
// Grid cells comfortably larger than any plausible radius (≤1 km), so a probe
// touches at most a 3×3 neighbourhood.
const CELL_DEG = 0.02;

/**
 * Phone comparison key: digits only, trimmed to the last 10 — so formatting
 * ("(604) 555 0100") and a +1 country-code prefix don't hide a match. Ten
 * digits is the NANP national number, which is what this dataset carries.
 */
function phoneKey(phone: string | null): string {
	const digits = phone?.replace(/\D/g, '') ?? '';
	return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Flags every pair of OPEN locations within `radius_m` of each other whose
 * names match (normalized) or that share a brand. Nearest pairs first;
 * `limit` caps the returned list with the remainder counted in `additional`.
 * `brand_id` scopes the audit to pairs where at least one half belongs to that
 * chain (e.g. a post-import sweep).
 */
export async function findDuplicateLocations(
	db: D1Like,
	opts: { radius_m?: number; limit?: number; brand_id?: string } & DismissalOpts = {}
): Promise<FindDuplicateLocationsResult> {
	const radiusM = opts.radius_m ?? DEFAULT_RADIUS_M;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const filter = new DismissFilter(opts);

	const { results: locations } = await db
		.prepare(
			`SELECT id, name, brand_id, latitude, longitude, street, city, postcode, phone, website
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
			minLng: a.longitude - padDeg,
			maxLng: a.longitude + padDeg
		})) {
			if (j <= i) continue; // each unordered pair once
			const b = locations[j];
			if (opts.brand_id && a.brand_id !== opts.brand_id && b.brand_id !== opts.brand_id) continue;
			const distance = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
			if (distance > radiusM) continue;
			const nameHit = namesMatch(normalized[i], normalized[j]);
			const brandHit = Boolean(a.brand_id) && a.brand_id === b.brand_id;
			if (!nameHit && !brandHit) continue;
			// A dismissal means this exact pair was already verified as two real
			// venues — suppress it instead of re-flagging forever. The pair itself is
			// the evidence, so the fingerprint has no further dimension.
			const decision = filter.evaluate(orderedPair(a.id, b.id).join('|'), '');
			if (decision.drop) continue;
			const phoneHit = phoneKey(a.phone).length > 0 && phoneKey(a.phone) === phoneKey(b.phone);
			pairs.push({
				distance_m: Math.round(distance),
				names_match: nameHit,
				same_brand: brandHit,
				same_phone: phoneHit,
				confidence: (nameHit && distance <= HIGH_CONFIDENCE_M) || phoneHit ? 'high' : 'review',
				a,
				b,
				...decision.fields
			});
		}
	});

	pairs.sort((x, y) => x.distance_m - y.distance_m);
	return {
		pairs: pairs.slice(0, limit),
		additional: Math.max(0, pairs.length - limit),
		suppressed_dismissed: filter.suppressed,
		scanned: locations.length,
		radius_m: radiusM
	};
}
