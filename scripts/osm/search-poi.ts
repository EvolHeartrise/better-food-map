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
import { stripDiacritics } from '../../src/lib/text';
import { bboxAround, haversineMeters, type Bbox } from './geo';
import { effectivePoiAddressParts, osmUrl, poiCountry, type PoiAddressParts } from './map-feature';
import type { OsmPoiStore, StoredPoi } from './poi-store';

export interface SearchPoiParams {
	/** Explicit bounding box. Provide this OR latitude+longitude+radius_km. */
	bbox?: Bbox;
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
	/** Whether results were capped by `limit`. */
	truncated: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SCAN_CAP = 2000;

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
}

/** Resolves the query area to a bounding box, plus an optional centre for radius refine. */
export function resolveArea(params: SearchPoiParams): {
	bbox: Bbox;
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

/** True if `poi` is essentially the same venue as one already in `existing`. */
export function isExistingDuplicate(poi: StoredPoi, existing: ExistingLocation[]): boolean {
	const poiName = normalizeName(poi.name);
	for (const loc of existing) {
		const locName = normalizeName(loc.name);
		const d = haversineMeters(poi.latitude, poi.longitude, loc.latitude, loc.longitude);
		// Same spot: a duplicate unless the names clearly disagree (food-court neighbours).
		if (d <= SAME_POINT_M && !namesConflict(poiName, locName)) return true;
		// Nearby with a matching name: the same venue, just slightly displaced.
		if (d <= SAME_NAME_M && namesMatch(poiName, locName)) return true;
	}
	return false;
}

/** Fetches existing locations whose point falls within `bbox` from D1. */
export async function existingInBbox(db: D1Like, bbox: Bbox): Promise<ExistingLocation[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, latitude, longitude FROM locations
			 WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`
		)
		.bind(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon)
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

	let rows = store.searchBbox(bbox, {
		category: params.category ?? undefined,
		name: params.name,
		cuisine: params.cuisine,
		cap: SCAN_CAP
	});
	if (params.exclude_osm_ids?.length) {
		const excluded = new Set(params.exclude_osm_ids);
		rows = rows.filter((poi) => !excluded.has(poi.osm_id));
	}
	let excludedForeign = 0;
	if (params.country) {
		const scope = params.country.toUpperCase();
		rows = rows.filter((poi) => {
			const c = poiCountry(poi);
			if (c === null || c === scope) return true;
			excludedForeign++;
			return false;
		});
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
		const existing = await existingInBbox(db, bbox);
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
		truncated
	};
}
