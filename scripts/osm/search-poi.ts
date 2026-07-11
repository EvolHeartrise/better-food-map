// ---------------------------------------------------------------------------
// search_poi: query the local OSM POI staging store for food venues in an area,
// and (by default) drop any that already exist in the production D1 — so an agent
// filling in a city only ever sees venues still missing from the map.
//
// Dedup, not fetching, is the hard part at continental scale, so it lives here
// rather than in each calling agent. Everything is deterministic and offline
// except the single D1 read used to find existing locations.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { normalizeCountry } from '../../src/lib/address';
import { stripDiacritics } from '../../src/lib/text';
import { bboxAround, haversineMeters, type Bounds } from './geo';
import { effectivePoiAddressParts, osmUrl, poiCountry, type PoiAddressParts } from './map-feature';
import type { OsmPoiStore, StoredPoi } from './poi-store';

export interface SearchPoiParams {
	/** Explicit bounding box. Provide this OR latitude+longitude+radius_km. */
	bbox?: Bounds;
	latitude?: number;
	longitude?: number;
	radius_km?: number;
	category?: StoredPoi['suggested_category'];
	name?: string;
	cuisine?: string;
	/**
	 * ISO-2 country scope (e.g. "CA"). Drops POIs whose address SIGNALS a
	 * different country (explicit addr:country, or a region code that belongs to
	 * another country — CA province and US state codes are disjoint); POIs with
	 * no country signal are kept, since an unresolvable address can't prove the
	 * POI is out of scope. Guards border-spanning bboxes: a Canada extract
	 * carries some US border-town POIs.
	 */
	country?: string;
	/** Drop POIs already present in D1 (default true). */
	exclude_existing?: boolean;
	/**
	 * osm_ids to drop from the results — e.g. known false name matches that would
	 * otherwise resurface on every re-search of the same area. Applied before
	 * `limit`, so excluded candidates never crowd out real ones.
	 */
	exclude_osm_ids?: string[];
	/** Max candidates to return (default 50). */
	limit?: number;
	/** Override the staging-store scan cap (testing only). */
	scanCap?: number;
}

/** One POI returned to the caller, ready to hand to create_locations. */
export interface PoiCandidate {
	osm_id: string;
	osm_type: StoredPoi['osm_type'];
	/** openstreetmap.org URL — cite this as the source on the created location. */
	osm_url: string;
	name: string | null;
	suggested_category: StoredPoi['suggested_category'];
	osm_class: string;
	cuisine: string | null;
	latitude: number;
	longitude: number;
	/**
	 * Structured address parts (street/city/region/postcode/country, absent parts
	 * dropped), merged per part from the POI's OWN `addr:*` tags, the address an
	 * enrichment feed (containing OSM building / Overture) supplied, and the
	 * extract-time admin-boundary join for city/region — exactly what an `osm_id`
	 * import stores, so there is nothing to copy through. Omitted only when no
	 * source has any part. `country` is often absent — create_locations defaults
	 * it to CA.
	 */
	address_parts?: PoiAddressParts;
	/**
	 * Provenance of `address_parts`: null = the POI's own OSM data, cite `osm_url`
	 * (which create_locations auto-cites when given `osm_id`); a non-null label (e.g.
	 * "overture:<id> (2026-06-17.0)") = an external feed supplied the address — cite it
	 * as an extra source on the created location.
	 */
	address_source: string | null;
	phone: string | null;
	website: string | null;
	/**
	 * Provenance of `phone` / `website`, mirroring `address_source`: null = the
	 * POI's own OSM tags; "overture:<id> (<release>)" = filled by the Overture
	 * contacts enrichment (bun run overture:enrich).
	 */
	phone_source: string | null;
	website_source: string | null;
	opening_hours: string | null;
	/** Distance from the query centre in metres (only for centre+radius queries). */
	distance_m?: number;
}

export interface SearchPoiResult {
	candidates: PoiCandidate[];
	/** Food POIs found in the area before exclusion/limit. */
	total_in_area: number;
	/** How many were dropped as already-in-DB (0 when exclude_existing is false). */
	excluded_existing: number;
	/** POIs dropped because their address signals a different country (only with `country`). */
	excluded_foreign?: number;
	/** Up to 10 of the foreign-dropped POIs, so the drop is auditable, never silent. */
	excluded_foreign_sample?: { osm_id: string; name: string | null; country: string }[];
	/** Whether results were capped by `limit`. */
	truncated: boolean;
	/**
	 * Whether the staging-store scan hit its row cap BEFORE any exclusion, so the
	 * box holds more food POIs than were even considered. When set, `total_in_area`
	 * is a lower bound, and re-sweeping the same box after imports will keep
	 * returning the same capped slice — narrow the bbox / lower the radius instead
	 * of concluding the area is exhausted. Mirrors import_chain's `scan_truncated`.
	 */
	scan_truncated: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SCAN_CAP = 2000;
const FOREIGN_SAMPLE = 10;

/** One foreign-dropped POI, for the audit sample. */
export interface ForeignDrop {
	osm_id: string;
	name: string | null;
	/** The country the POI's address signalled (never the requested scope). */
	country: string;
}

/**
 * Splits POIs into those compatible with an ISO-2 country scope (matching
 * signal, or no signal at all — an unresolvable address can't prove a POI
 * foreign) and a sample-carrying summary of the dropped rest. The scope is
 * folded through the same normalizeCountry as the per-POI signal, so spellings
 * ("UK" vs "GB") can never disagree. Shared by search_poi and import_chain.
 */
export function partitionByCountry(
	pois: StoredPoi[],
	countryScope: string
): { kept: StoredPoi[]; dropped: number; sample: ForeignDrop[] } {
	const scope = normalizeCountry(countryScope) ?? countryScope.trim().toUpperCase();
	const kept: StoredPoi[] = [];
	let dropped = 0;
	const sample: ForeignDrop[] = [];
	for (const poi of pois) {
		const c = poiCountry(poi);
		if (c === null || c === scope) {
			kept.push(poi);
			continue;
		}
		dropped++;
		if (sample.length < FOREIGN_SAMPLE)
			sample.push({ osm_id: poi.osm_id, name: poi.name, country: c });
	}
	return { kept, dropped, sample };
}

// Dedup thresholds. A staging POI is considered already-present when an existing
// location is essentially on the same spot, or close with a matching name.
// The same-spot rule is suppressed when both names are known and clearly differ,
// so distinct brands sharing a coordinate (food court / mall unit) aren't hidden.
// Coordinates are OSM-sourced and passed through verbatim (see CLAUDE.md "Location
// coordinates must be OSM-based"), so a venue we already imported sits ~0 m from
// its staging POI. SAME_POINT_M is kept tight to that identity: real neighbours a
// few metres away stay their own candidates instead of being silently absorbed.
const SAME_POINT_M = 10;
const SAME_NAME_M = 150;
const MIN_NAME_OVERLAP = 4;

export interface ExistingLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	/**
	 * The chain this venue belongs to, or null when it is independent. Carried so
	 * a caller deduping against the map can tell an already-linked branch of its
	 * chain (silent skip) from an UNLINKED lookalike sitting at the same spot (a
	 * venue that should be adopted onto the chain, e.g. issue #242's stray A&W).
	 */
	brand_id?: string | null;
}

/** Resolves the query area to a bounding box, plus an optional centre for radius refine. */
export function resolveArea(params: SearchPoiParams): {
	bbox: Bounds;
	centre?: { lat: number; lon: number; radiusKm: number };
} {
	if (params.bbox) return { bbox: params.bbox };
	const { latitude, longitude, radius_km } = params;
	if (latitude === undefined || longitude === undefined || radius_km === undefined) {
		throw new Error('Provide either `bbox` or all of `latitude`, `longitude` and `radius_km`.');
	}
	return {
		bbox: bboxAround(latitude, longitude, radius_km),
		centre: { lat: latitude, lon: longitude, radiusKm: radius_km }
	};
}

/** Normalises a venue name for fuzzy comparison: lowercase, accents and punctuation stripped. */
export function normalizeName(name: string | null | undefined): string {
	if (!name) return '';
	return stripDiacritics(name)
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, '');
}

/** True when two normalised names are equal or one meaningfully contains the other. */
export function namesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const shorter = a.length <= b.length ? a : b;
	const longer = a.length <= b.length ? b : a;
	return shorter.length >= MIN_NAME_OVERLAP && longer.includes(shorter);
}

/**
 * True when both names are known and clearly refer to different venues. Used to
 * stop the same-point rule from collapsing distinct businesses that merely share
 * a coordinate (e.g. several brands in one food court or mall unit). A missing
 * name on either side is treated as "no conflict" — we can't tell them apart, so
 * the conservative same-spot dedup still applies.
 */
function namesConflict(a: string, b: string): boolean {
	return a !== '' && b !== '' && !namesMatch(a, b);
}

/**
 * The existing venue `poi` is essentially the same as, or null when none —
 * the match core behind {@link isExistingDuplicate}. Returns the matched row so
 * a caller can inspect it (e.g. its `brand_id`, to tell an already-linked branch
 * from an unlinked lookalike); the first match in `existing` order wins.
 */
export function findExistingDuplicate(
	poi: StoredPoi,
	existing: ExistingLocation[]
): ExistingLocation | null {
	const poiName = normalizeName(poi.name);
	for (const loc of existing) {
		const locName = normalizeName(loc.name);
		const d = haversineMeters(poi.latitude, poi.longitude, loc.latitude, loc.longitude);
		// Same spot: a duplicate unless the names clearly disagree (food-court neighbours).
		if (d <= SAME_POINT_M && !namesConflict(poiName, locName)) return loc;
		// Nearby with a matching name: the same venue, just slightly displaced.
		if (d <= SAME_NAME_M && namesMatch(poiName, locName)) return loc;
	}
	return null;
}

/** True if `poi` is essentially the same venue as one already in `existing`. */
export function isExistingDuplicate(poi: StoredPoi, existing: ExistingLocation[]): boolean {
	return findExistingDuplicate(poi, existing) !== null;
}

/**
 * Pads `bbox` by SAME_NAME_M on every side, for the dedup fetch. A stored venue
 * can sit just OUTSIDE the query bbox (e.g. its OSM node moved since import)
 * while still within SAME_NAME_M of an in-bbox POI; fetching only the exact bbox
 * would let that POI escape same-name dedup and become a duplicate pin.
 * {@link bboxAround} supplies the metres→degrees math at the bbox's worst
 * (widest-longitude) latitude, mirroring nearDuplicateWarnings in db-mcp-server.
 */
export function padBboxForDedup(bbox: Bounds): Bounds {
	const worstLat = Math.max(Math.abs(bbox.minLat), Math.abs(bbox.maxLat));
	const pad = bboxAround(worstLat, 0, SAME_NAME_M / 1000);
	const padLat = pad.maxLat - worstLat; // degrees covering SAME_NAME_M in latitude
	const padLon = pad.maxLng; // and in longitude at the worst latitude (centre lng 0)
	return {
		minLat: Math.max(bbox.minLat - padLat, -90),
		maxLat: Math.min(bbox.maxLat + padLat, 90),
		minLng: Math.max(bbox.minLng - padLon, -180),
		maxLng: Math.min(bbox.maxLng + padLon, 180)
	};
}

/** Fetches existing locations whose point falls within `bbox` from D1. */
export async function existingInBbox(db: D1Like, bbox: Bounds): Promise<ExistingLocation[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, latitude, longitude, brand_id FROM locations
			 WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`
		)
		.bind(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng)
		.all<ExistingLocation>();
	return results;
}

function toCandidate(poi: StoredPoi, distance_m?: number): PoiCandidate {
	// The same merged parts create_locations resolves an osm_id import against
	// (own addr:* tags → enriched line → admin-boundary city/region), so what a
	// candidate advertises is exactly what an import would store.
	const addressParts = effectivePoiAddressParts(poi);
	return {
		osm_id: poi.osm_id,
		osm_type: poi.osm_type,
		osm_url: osmUrl(poi.osm_type, poi.numeric_id),
		name: poi.name,
		suggested_category: poi.suggested_category,
		osm_class: poi.osm_class,
		cuisine: poi.cuisine,
		latitude: poi.latitude,
		longitude: poi.longitude,
		...(addressParts ? { address_parts: addressParts } : {}),
		address_source: poi.address_source,
		phone: poi.phone,
		website: poi.website,
		phone_source: poi.phone_source,
		website_source: poi.website_source,
		opening_hours: poi.opening_hours,
		...(distance_m === undefined ? {} : { distance_m: Math.round(distance_m) })
	};
}

/**
 * Searches the staging store for food POIs in an area, refines a centre+radius
 * query to the exact circle, optionally removes venues already in D1, and returns
 * up to `limit` candidates (nearest-first for radius queries).
 *
 * `db` may be null only when `exclude_existing` is false (offline/testing).
 */
export async function searchPoi(
	store: OsmPoiStore,
	db: D1Like | null,
	params: SearchPoiParams
): Promise<SearchPoiResult> {
	const { bbox, centre } = resolveArea(params);
	const excludeExisting = params.exclude_existing ?? true;
	const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

	const scanCap = params.scanCap ?? SCAN_CAP;
	let rows = store.searchBbox(bbox, {
		category: params.category ?? undefined,
		name: params.name,
		cuisine: params.cuisine,
		cap: scanCap
	});
	// Captured before any exclusion/partition shrinks `rows`: truncation is a
	// property of the raw scan, not of what survives the filters.
	const scanTruncated = rows.length >= scanCap;
	if (params.exclude_osm_ids?.length) {
		const excluded = new Set(params.exclude_osm_ids);
		rows = rows.filter((poi) => !excluded.has(poi.osm_id));
	}
	let excludedForeign = 0;
	let excludedForeignSample: ForeignDrop[] = [];
	if (params.country) {
		const { kept, dropped, sample } = partitionByCountry(rows, params.country);
		rows = kept;
		excludedForeign = dropped;
		excludedForeignSample = sample;
	}

	// Attach distance and trim to the exact circle for centre+radius queries.
	let withDistance: { poi: StoredPoi; distance_m?: number }[];
	if (centre) {
		const radiusM = centre.radiusKm * 1000;
		withDistance = rows
			.map((poi) => ({
				poi,
				distance_m: haversineMeters(centre.lat, centre.lon, poi.latitude, poi.longitude)
			}))
			.filter((x) => x.distance_m <= radiusM)
			.toSorted((a, b) => a.distance_m - b.distance_m);
	} else {
		withDistance = rows.map((poi) => ({ poi }));
	}

	const totalInArea = withDistance.length;

	let excluded = 0;
	if (excludeExisting) {
		if (!db) throw new Error('exclude_existing requires a database handle.');
		// Padded past SAME_NAME_M: a moved-node venue just outside the bbox must
		// still block same-name dedup for an in-bbox edge POI (see padBboxForDedup).
		const existing = await existingInBbox(db, padBboxForDedup(bbox));
		const kept: typeof withDistance = [];
		for (const x of withDistance) {
			if (isExistingDuplicate(x.poi, existing)) excluded++;
			else kept.push(x);
		}
		withDistance = kept;
	}

	const truncated = withDistance.length > limit;
	const candidates = withDistance.slice(0, limit).map((x) => toCandidate(x.poi, x.distance_m));

	return {
		candidates,
		total_in_area: totalInArea,
		excluded_existing: excluded,
		...(params.country === undefined ? {} : { excluded_foreign: excludedForeign }),
		...(excludedForeignSample.length ? { excluded_foreign_sample: excludedForeignSample } : {}),
		truncated,
		scan_truncated: scanTruncated
	};
}
