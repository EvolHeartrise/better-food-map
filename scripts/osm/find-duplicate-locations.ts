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
import { DEFAULT_PAGE_LIMIT, clampLimit } from './paging';
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
	/** Source identity (migration 0028) — how the staging phone fallback resolves. */
	osm_id: string | null;
}

/** The staging-store surface the phone fallback reads (OsmPoiStore satisfies it). */
export interface StagingPhoneStoreLike {
	getByOsmId(osmId: string): { phone: string | null; phone_source: string | null } | null;
}

export interface DuplicatePair extends DismissableFinding {
	/** Metres between the two points (the sort key — closest pairs first). */
	distance_m: number;
	/** True when the two names match after normalization. */
	names_match: boolean;
	/** True when both carry the same non-null brand_id. */
	same_brand: boolean;
	/** True when both VENUE ROWS carry the same non-null phone (digits compared) — strong same-store evidence. */
	same_phone: boolean;
	/**
	 * True when the phones match only via the STAGING-STORE fallback: a half
	 * with no phone of its own resolved through its `osm_id` to its staging
	 * POI's phone (often Overture-enriched). WEAKER than `same_phone` — a
	 * staging phone comes from a ~100 m name-related feed match, not from the
	 * venue row itself, so two nearby related-name venues CAN inherit one
	 * Overture place's number. Corroborating evidence for verification, never a
	 * confidence upgrade on its own.
	 */
	same_phone_staging: boolean;
	/**
	 * Present only when `same_phone_staging` is true: BOTH sides' staging phones
	 * were donated by the SAME Overture place (their `phone_source` labels carry
	 * one overture id) — the "match" is one upstream datum echoed twice, not two
	 * independent records agreeing. Read a true value as no extra corroboration.
	 */
	same_phone_staging_same_donor?: boolean;
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

/** The Overture place id inside an "overture:<id> (<release>)" provenance label, or null. */
function overtureDonor(source: string | null): string | null {
	const match = source?.match(/^overture:(\S+)/);
	return match ? match[1] : null;
}

/**
 * The staging-phone fallback for one flagged pair: each half's effective phone
 * is its own when it has one, otherwise its staging POI's (via `osm_id`).
 * A hit requires that at least one half actually used the staging value —
 * two venue-row phones comparing equal is `same_phone`'s job, and comparing
 * unequal is already a verdict the store must not overrule. `sameDonor` marks
 * the circular case: both staging phones trace (via `phone_source`) to ONE
 * Overture place, so the agreement is a single upstream datum, not two.
 */
function stagingPhoneHit(
	a: DuplicateHalf,
	b: DuplicateHalf,
	store: StagingPhoneStoreLike
): { hit: boolean; sameDonor: boolean } {
	const effective = (
		half: DuplicateHalf
	): { key: string; staging: boolean; donor: string | null } => {
		const own = phoneKey(half.phone);
		if (own.length > 0) return { key: own, staging: false, donor: null };
		const poi = half.osm_id ? store.getByOsmId(half.osm_id) : null;
		return {
			key: phoneKey(poi?.phone ?? null),
			staging: true,
			donor: overtureDonor(poi?.phone_source ?? null)
		};
	};
	const ea = effective(a);
	const eb = effective(b);
	const hit = (ea.staging || eb.staging) && ea.key.length > 0 && ea.key === eb.key;
	return { hit, sameDonor: hit && ea.donor !== null && ea.donor === eb.donor };
}

/**
 * Flags every pair of OPEN locations within `radius_m` of each other whose
 * names match (normalized) or that share a brand. Nearest pairs first;
 * `limit` caps the returned list with the remainder counted in `additional`.
 * `brand_id` scopes the audit to pairs where at least one half belongs to that
 * chain (e.g. a post-import sweep). `store` (the local staging store, optional)
 * only ENRICHES evidence: a flagged half with no phone of its own borrows its
 * staging POI's phone via `osm_id`, reported as `same_phone_staging` — pair
 * discovery itself never touches the store.
 */
export async function findDuplicateLocations(
	db: D1Like,
	opts: {
		radius_m?: number;
		limit?: number;
		brand_id?: string;
		store?: StagingPhoneStoreLike;
	} & DismissalOpts = {}
): Promise<FindDuplicateLocationsResult> {
	const radiusM = opts.radius_m ?? DEFAULT_RADIUS_M;
	// No min/max/trunc: this audit deliberately imposes no MAX cap on `limit`
	// (unlike the other finders) — preserved by opting out of both bounds.
	const limit = clampLimit(opts.limit, { def: DEFAULT_PAGE_LIMIT, trunc: false });
	const filter = new DismissFilter(opts);

	const { results: locations } = await db
		.prepare(
			`SELECT id, name, brand_id, latitude, longitude, street, city, postcode, phone, website, osm_id
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
			// Staging fallback, flagged pairs only (never part of discovery): a half
			// with no phone of its own stands in its staging POI's (often
			// Overture-enriched) phone. Both halves carrying their OWN, differing
			// phones is already an answer — the store is not consulted then.
			const staging =
				!phoneHit && opts.store
					? stagingPhoneHit(a, b, opts.store)
					: { hit: false, sameDonor: false };
			pairs.push({
				distance_m: Math.round(distance),
				names_match: nameHit,
				same_brand: brandHit,
				same_phone: phoneHit,
				same_phone_staging: staging.hit,
				...(staging.hit ? { same_phone_staging_same_donor: staging.sameDonor } : {}),
				// Deliberately unchanged by stagingHit — staging evidence is weaker
				// (see the field doc) and must not promote a pair to "high" alone.
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
