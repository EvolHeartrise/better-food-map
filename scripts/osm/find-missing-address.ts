// ---------------------------------------------------------------------------
// find_missing_address: audit existing locations for a missing (or streetless)
// address and, where possible, surface the address from their OpenStreetMap POI
// so it can be backfilled.
//
// Addresses should be present and OSM-sourced, the same way coordinates are
// (see CLAUDE.md "Location coordinates must be OSM-based"). A location imported
// from OSM sits ~0 m from its staging POI, so the POI that NAME-matches it nearby
// is the one its address should come from. For each flagged location this finds
// that POI and returns its structured `osm_address_parts` (street/city/region/
// postcode/country, ready for update_location) — plus a single-line `osm_address`
// preview and `osm_url` to cite — or reports that OSM has no address to give (the
// POI is itself addressless, or there is no name-matching POI nearby).
//
// Like find_coordinate_drift, the only non-deterministic input is the single D1
// read; the matching itself is offline against the staging store.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { composeAddressLine } from '../../src/lib/address';
import { osmAddressParts, osmUrl } from './map-feature';
import type { OsmPoiStore, StoredPoi } from './poi-store';
import { LOCATION_AUDIT, nearestNameMatch } from './poi-match';

export interface FindMissingAddressParams {
	/** Max flagged locations to return (default 50, max 200). */
	limit?: number;
	/**
	 * How far to look for a name-matching OSM POI before reporting no match
	 * (default 250, max 50000). A location is OSM-sourced, so its source POI sits
	 * ~0 m away; kept modest so a match is confidently the same venue. Widen it to
	 * hunt relocated matches, but then sanity-check `distance_m`.
	 */
	search_radius_m?: number;
	/**
	 * Also flag locations whose stored address is non-empty but clearly NOT a
	 * usable street address — a streetless fragment such as a bare house number or
	 * postcode (no letter in any script). Default true.
	 */
	include_incomplete?: boolean;
	/**
	 * Include the locations OSM cannot fix — `osm_has_no_address` and
	 * `no_osm_match` — in the returned list (they are always counted regardless).
	 * Set false to get just the actionable, OSM-fixable work list. Default true.
	 */
	include_unfixable?: boolean;
}

export interface MissingAddressLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	/** A single-line view of the parts stored today (null when nothing usable is stored). */
	current_address: string | null;
	/** Required structured parts that are absent, e.g. ["region", "country"]. */
	missing_parts: string[];
	/** Why this location was flagged: no street at all, or a street but a missing required part. */
	reason: 'missing' | 'incomplete';
	/**
	 * What can be done about it:
	 *   'osm_fix_available' — a name-matching OSM POI nearby HAS a usable address; apply it.
	 *   'osm_has_no_address' — matched an OSM POI, but it too lacks a usable address.
	 *   'no_osm_match'       — no name-matching OSM POI within search_radius_m.
	 */
	classification: 'osm_fix_available' | 'osm_has_no_address' | 'no_osm_match';
	/**
	 * Structured parts to pass to update_location (osm_fix_available only, and only
	 * when the matched POI carries its OWN `addr:*` tags — present is preferred over
	 * splitting `osm_address` by hand). The server normalizes region/postcode/country,
	 * so pass the parts through unchanged. May be partial (e.g. no country); supply
	 * any still-missing required part yourself. Absent when the address came from an
	 * external feed or a containing building rather than the POI's own tags — then
	 * split `osm_address` into parts yourself.
	 */
	osm_address_parts?: Partial<
		Record<'street' | 'city' | 'region' | 'postcode' | 'country', string>
	>;
	/**
	 * A single-line preview of the matched OSM address (osm_fix_available only).
	 * Prefer `osm_address_parts` for update_location; fall back to splitting this
	 * into structured parts when `osm_address_parts` is absent.
	 */
	osm_address?: string;
	/**
	 * Where `osm_address` came from (osm_fix_available only): null/absent = the
	 * matched OSM POI's own tags or an OSM building it sits in (cite `osm_url`); a
	 * non-null label like "overture:<id> (2026-06-17.0)" = an external feed filled
	 * the address — cite THAT as a distinct source in addition to the OSM POI.
	 */
	address_source?: string | null;
	/** The matched OSM POI URL — cite as the source when backfilling (whenever a POI matched). */
	osm_url?: string;
	matched_osm_name?: string | null;
	/** Metres from the stored point to the matched OSM POI (whenever a POI matched). */
	distance_m?: number;
}

export interface FindMissingAddressResult {
	locations: MissingAddressLocation[];
	/** Total DB locations scanned. */
	scanned: number;
	/** Total locations flagged in scope (missing, plus incomplete when include_incomplete). */
	total_missing: number;
	/** How many of those are in `locations`. */
	returned: number;
	/** Flagged locations NOT returned because of `limit` / `include_unfixable`. */
	additional: number;
	/** Full breakdown of what was found, regardless of include_unfixable. */
	counts: {
		osm_fix_available: number;
		osm_has_no_address: number;
		no_osm_match: number;
		by_reason: { missing: number; incomplete: number };
	};
}

const { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M } = LOCATION_AUDIT;

interface LocationRow {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
}

/**
 * True when `address` is a usable street address. We can't fully parse a free
 * string, but the streetless fragments OSM's composer emits from a lone
 * `addr:housenumber`/`addr:postcode` (e.g. "31", "90210") have no letter in any
 * script, whereas a real street ("12 Main St", a CJK street) always does. So
 * "contains a letter" is a conservative usability signal that errs toward
 * keeping borderline addresses rather than over-flagging.
 */
export function usableAddress(address: string | null | undefined): string | null {
	if (!address) return null;
	const trimmed = address.trim();
	return trimmed !== '' && /\p{L}/u.test(trimmed) ? trimmed : null;
}

/**
 * The matched POI's OWN address parts (from its `addr:*` tags), as a ready-to-pass
 * update_location patch — or undefined when the POI carries no addr:* tags (its
 * address came from an enrichment feed or a containing building, not its own tags),
 * in which case the caller exposes only the single-line `osm_address`.
 */
function osmFixParts(poi: StoredPoi): MissingAddressLocation['osm_address_parts'] {
	let props: Record<string, string>;
	try {
		props = JSON.parse(poi.tags_json) as Record<string, string>;
	} catch {
		return undefined;
	}
	const parts = osmAddressParts(props);
	const out: NonNullable<MissingAddressLocation['osm_address_parts']> = {};
	if (parts.street) out.street = parts.street;
	if (parts.city) out.city = parts.city;
	if (parts.region) out.region = parts.region;
	if (parts.postcode) out.postcode = parts.postcode;
	if (parts.country) out.country = parts.country;
	return Object.keys(out).length ? out : undefined;
}

/** The REQUIRED structured parts (street/city/region/country) that are absent. */
export function missingRequiredParts(row: {
	street: string | null;
	city: string | null;
	region: string | null;
	country: string | null;
}): string[] {
	const out: string[] = [];
	if (!row.street?.trim()) out.push('street');
	if (!row.city?.trim()) out.push('city');
	if (!row.region?.trim()) out.push('region');
	if (!row.country?.trim()) out.push('country');
	return out;
}

/** Best-effort single-line view of whatever parts are stored (for diagnostics). */
function displayParts(row: LocationRow): string | null {
	return composeAddressLine(row);
}

async function allLocations(db: D1Like): Promise<LocationRow[]> {
	const { results } = await db
		.prepare(
			'SELECT id, name, latitude, longitude, street, city, region, postcode, country FROM locations'
		)
		.all<LocationRow>();
	return results;
}

/**
 * Scans every location, keeps those whose stored address is missing (or, when
 * `include_incomplete`, a streetless fragment), and matches each to the nearest
 * name-matching OSM staging POI (same normalisation/containment rule as
 * search_poi's dedup). The POI's address — when it has a usable one — is returned
 * as `osm_address` for a verbatim update_location backfill.
 *
 * Returns actionable-first (osm_fix_available, then osm_has_no_address, then
 * no_osm_match) so the `limit` window surfaces the easy OSM backfills first, with
 * `additional` reporting how many more were found.
 */
export async function findMissingAddress(
	store: OsmPoiStore,
	db: D1Like,
	params: FindMissingAddressParams
): Promise<FindMissingAddressResult> {
	const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	const searchRadiusKm =
		Math.min(Math.max(0, params.search_radius_m ?? DEFAULT_SEARCH_RADIUS_M), MAX_SEARCH_RADIUS_M) /
		1000;
	const includeIncomplete = params.include_incomplete ?? true;
	const includeUnfixable = params.include_unfixable ?? true;

	const locations = await allLocations(db);

	const fixable: MissingAddressLocation[] = [];
	const osmHasNoAddress: MissingAddressLocation[] = [];
	const noOsmMatch: MissingAddressLocation[] = [];
	let missingCount = 0;
	let incompleteCount = 0;

	for (const loc of locations) {
		const missingParts = missingRequiredParts(loc);
		// Decide whether (and why) this location needs attention. A location with no
		// street is 'missing'; one that has a street but lacks another required part
		// (city/region/country) is 'incomplete'.
		let reason: 'missing' | 'incomplete';
		if (missingParts.includes('street')) {
			reason = 'missing';
		} else if (missingParts.length > 0) {
			if (!includeIncomplete) continue;
			reason = 'incomplete';
		} else {
			continue; // all required parts present — nothing to do
		}
		if (reason === 'missing') missingCount++;
		else incompleteCount++;

		// Find the nearest name-matching OSM POI — the one this venue's address
		// should come from. A location is OSM-sourced, so it sits ~0 m from it.
		const best = nearestNameMatch(store, loc, searchRadiusKm);

		const base = {
			id: loc.id,
			name: loc.name,
			latitude: loc.latitude,
			longitude: loc.longitude,
			current_address: displayParts(loc),
			missing_parts: missingParts,
			reason
		} as const;

		if (!best) {
			noOsmMatch.push({ ...base, classification: 'no_osm_match' });
			continue;
		}

		const matched = {
			osm_url: osmUrl(best.poi.osm_type, best.poi.numeric_id),
			matched_osm_name: best.poi.name,
			distance_m: Math.round(best.dist)
		};

		const osmAddress = usableAddress(best.poi.address);
		if (osmAddress) {
			fixable.push({
				...base,
				classification: 'osm_fix_available',
				osm_address: osmAddress,
				osm_address_parts: osmFixParts(best.poi),
				address_source: best.poi.address_source ?? null,
				...matched
			});
		} else {
			osmHasNoAddress.push({ ...base, classification: 'osm_has_no_address', ...matched });
		}
	}

	// Actionable first; within osm_fix_available, nearest match first (most
	// confidently the same venue). The unfixable tails keep DB order.
	fixable.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
	const ordered = includeUnfixable ? [...fixable, ...osmHasNoAddress, ...noOsmMatch] : [...fixable];

	const totalMissing = missingCount + incompleteCount;
	const returned = ordered.slice(0, limit);
	return {
		locations: returned,
		scanned: locations.length,
		total_missing: totalMissing,
		returned: returned.length,
		additional: totalMissing - returned.length,
		counts: {
			osm_fix_available: fixable.length,
			osm_has_no_address: osmHasNoAddress.length,
			no_osm_match: noOsmMatch.length,
			by_reason: { missing: missingCount, incomplete: incompleteCount }
		}
	};
}
