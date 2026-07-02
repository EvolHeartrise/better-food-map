// ---------------------------------------------------------------------------
// Maps one OpenStreetMap food POI (a GeoJSON feature as emitted by
// `osmium export -f geojsonseq`) to the flat row we store in the local POI
// staging DB. Pure functions, no I/O — unit-tested in map-feature.test.ts.
//
// What counts as a "food POI" is defined by FOOD_AMENITIES / FOOD_SHOPS below;
// the same lists drive the `osmium tags-filter` step in scripts/osm-extract.ts,
// so keep them in sync.
// ---------------------------------------------------------------------------

// Type-only import (erased at build time): `SuggestedCategory` aliases the
// canonical category union rather than restating it. The scripts layer already
// depends on src/lib (see search-poi.ts), so this adds no new coupling.
import type { Category } from '../../src/lib/category';
import {
	composeAddressLine,
	composeStreet,
	normalizePostcode,
	normalizeRegion
} from '../../src/lib/address';
import { blankToNull } from '../../src/lib/text';

/** A GeoJSON feature, as produced by osmium export (geometry may be any type). */
export interface OsmFeature {
	type?: string;
	id?: string | number;
	properties?: Record<string, string> | null;
	geometry?: { type: string; coordinates: unknown } | null;
}

/** The app's location category enum (aliases the canonical `Category` in src/lib/category.ts). */
export type SuggestedCategory = Category;

/** Flat staging-store row for one OSM food POI. */
export interface PoiRow {
	/** Stable unique id, e.g. "n123" / "w456" / "r789" (osmium `@id` with type prefix). */
	osm_id: string;
	osm_type: 'node' | 'way' | 'relation';
	numeric_id: number;
	name: string | null;
	/** Raw OSM value that classified this as food, e.g. "restaurant", "cafe", "bakery". */
	osm_class: string;
	/** Best-fit app category, or null when no clean fit (bar/pub/ice_cream/…). */
	suggested_category: SuggestedCategory | null;
	cuisine: string | null;
	latitude: number;
	longitude: number;
	address: string | null;
	phone: string | null;
	website: string | null;
	opening_hours: string | null;
	/**
	 * Venue-level OSM `diet:*=yes|only` markers, mapped to our dietary tag ids.
	 * Informational provenance only — they describe the venue, not a specific
	 * food item, so they never auto-apply (dietary tags stay source-asserted).
	 */
	diet_markers: string[];
	/** Full original OSM tag set, JSON-encoded, for reference/debugging. */
	tags_json: string;
	/**
	 * Municipality from the extract-time OSM admin-boundary join (enrich-admin.ts);
	 * null until enriched. The "OSM admin context" city fallback for POIs whose own
	 * tags carry none.
	 */
	admin_city: string | null;
	/** Province/state from the same join, as a 2-letter code when resolvable. */
	admin_region: string | null;
}

/** `amenity` values we treat as food POIs. */
export const FOOD_AMENITIES = [
	'restaurant',
	'cafe',
	'fast_food',
	'bar',
	'pub',
	'biergarten',
	'ice_cream',
	'food_court'
] as const;

/** `shop` values we treat as food POIs. */
export const FOOD_SHOPS = ['bakery', 'pastry', 'confectionery'] as const;

const AMENITY_SET = new Set<string>(FOOD_AMENITIES);
const SHOP_SET = new Set<string>(FOOD_SHOPS);

/** Maps an OSM diet key to our tag id; null when there is no faithful equivalent. */
const DIET_KEY_TO_TAG: Record<string, string> = {
	'diet:vegan': 'vegan',
	'diet:vegetarian': 'vegetarian',
	'diet:gluten_free': 'gluten_free',
	'diet:lactose_free': 'dairy_free',
	'diet:halal': 'halal'
};

/** Returns the OSM value (amenity, else shop) that classifies this as food, or null. */
export function classOf(props: Record<string, string>): string | null {
	if (props.amenity && AMENITY_SET.has(props.amenity)) return props.amenity;
	if (props.shop && SHOP_SET.has(props.shop)) return props.shop;
	return null;
}

/** OSM lifecycle prefixes marking a feature as no longer in service. */
const CLOSURE_PREFIXES = [
	'disused',
	'was',
	'abandoned',
	'razed',
	'demolished',
	'removed',
	'closed'
] as const;

function isYes(v: string | undefined): boolean {
	return v?.trim().toLowerCase() === 'yes';
}

/**
 * True when a POI's tags mark it permanently closed / no longer operating, so it
 * must be kept OUT of the staging store (a closed venue that still surfaces in
 * search_poi wastes an agent's research time re-discovering the closure).
 *
 * Catches the cases osmium's `amenity=`/`shop=` tags-filter does NOT: a venue that
 * keeps its primary `amenity`/`shop` tag but carries `disused=yes`/`abandoned=yes`,
 * an `opening_hours` of `closed`/`off`, or a lifecycle-prefixed classification key
 * (e.g. `disused:amenity`) left alongside the live one during a mapping transition.
 * (A POI tagged ONLY `disused:amenity=…` never reaches here — it fails {@link classOf}
 * and osmium's filter — so this is the belt-and-suspenders for mixed/legacy tagging.)
 *
 * Note: OSM lifecycle tags only cover venues OSM itself knows are closed. Venues that
 * closed in reality but are still live-tagged in OSM (stale data) pass this filter and
 * are caught downstream when an agent verifies closure and records it (mark_poi_closed).
 */
export function isClosed(props: Record<string, string>): boolean {
	const oh = props.opening_hours?.trim().toLowerCase();
	if (oh === 'closed' || oh === 'off') return true;
	if (isYes(props.disused) || isYes(props.abandoned)) return true;
	for (const prefix of CLOSURE_PREFIXES) {
		if (props[`${prefix}:amenity`] || props[`${prefix}:shop`]) return true;
	}
	return false;
}

/** Maps a food class to the best-fit app category (null when none fits cleanly). */
export function suggestedCategory(osmClass: string): SuggestedCategory | null {
	switch (osmClass) {
		case 'restaurant':
			return 'restaurant';
		case 'cafe':
			return 'cafe';
		case 'fast_food':
			return 'fast_food';
		case 'bakery':
		case 'pastry':
		case 'confectionery':
			return 'bakery';
		// bar / pub / biergarten / ice_cream / food_court have no clean app-enum
		// fit — leave null so the curating agent decides.
		default:
			return null;
	}
}

/** Structured address parts extracted from a POI's OSM `addr:*` tags (each null when absent). */
export interface OsmAddressParts {
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
}

/**
 * Extracts structured address parts from OSM `addr:*` tags, as the raw source
 * values — `region`/`postcode`/`country` are NOT normalized here (the MCP server
 * canonicalizes them when they reach create_locations/update_locations). The
 * `street` part includes the unit (Canadian hyphen style), composed by the same
 * {@link composeStreet} the backfill uses, so staging and backfill agree.
 */
export function osmAddressParts(props: Record<string, string>): OsmAddressParts {
	return {
		street: composeStreet(props['addr:housenumber'], props['addr:street'], props['addr:unit']),
		city: blankToNull(props['addr:city']),
		region: blankToNull(props['addr:state'] ?? props['addr:province']),
		postcode: blankToNull(props['addr:postcode']),
		country: blankToNull(props['addr:country'])
	};
}

/** A POI's own structured address parts with the absent ones dropped (for tool output). */
export type PoiAddressParts = Partial<
	Record<'street' | 'city' | 'region' | 'postcode' | 'country', string>
>;

/**
 * The POI's OWN structured address parts (from its `addr:*` tags), parsed from a
 * stored `tags_json` blob with the null parts dropped — or undefined when it
 * carries none (its address came from an enrichment feed or a containing building,
 * not its own tags). The ready-to-pass form for create_locations/update_locations;
 * shared by search_poi and find_missing_address so both expose it identically.
 */
export function osmOwnAddressParts(tagsJson: string): PoiAddressParts | undefined {
	let props: Record<string, string>;
	try {
		props = JSON.parse(tagsJson) as Record<string, string>;
	} catch {
		return undefined;
	}
	const parts = osmAddressParts(props);
	const out: PoiAddressParts = {};
	if (parts.street) out.street = parts.street;
	if (parts.city) out.city = parts.city;
	if (parts.region) out.region = parts.region;
	if (parts.postcode) out.postcode = parts.postcode;
	if (parts.country) out.country = parts.country;
	return Object.keys(out).length ? out : undefined;
}

/**
 * Composes a single-line address from OSM `addr:*` tags (null if none present).
 * Delegates the parts→string rendering to the canonical {@link composeAddressLine}
 * so staging strings match the display format the rest of the app uses.
 */
export function composeAddress(props: Record<string, string>): string | null {
	const { street, city, region, postcode } = osmAddressParts(props);
	return composeAddressLine({ street, city, region, postcode });
}

// A trailing postal/ZIP token, as {@link composeAddressLine} renders it inside the
// last segment: a Canadian "A1A 1A1" (optional inner space) or a US "12345"/"12345-6789".
const TRAILING_POSTCODE = /^(.*?)[\s,]+([A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d|\d{5}(?:-\d{4})?)$/;

/**
 * Recovers structured {@link PoiAddressParts} from a single-line address that WE
 * composed via {@link composeAddressLine} (`street, city, REGION postcode`; an older
 * staging vintage comma-joined region and postcode). The fallback for staging POIs
 * whose address came from enrichment — a containing OSM building or the Overture feed
 * — rather than their own `addr:*` tags, so the parts those feeds DID carry survive
 * even when the single line itself isn't surfaced.
 *
 * Robustness comes from validating the tail with the SAME normalizers the write path
 * uses: a trailing token becomes `postcode` only when {@link normalizePostcode} accepts
 * it, and a segment becomes `region` only when {@link normalizeRegion} does — so a city
 * is never mistaken for a region. Values are returned RAW (as written in the line, like
 * {@link osmOwnAddressParts}); create_locations/update_locations normalize them. The
 * remaining lead segments are `street, city` in composition order. `country` is never
 * recoverable (composeAddressLine omits it). Returns undefined when nothing is usable.
 */
export function addressPartsFromLine(line: string | null | undefined): PoiAddressParts | undefined {
	if (!line) return undefined;
	const segments = line
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (segments.length === 0) return undefined;

	const out: PoiAddressParts = {};

	// Peel the region/postcode tail. composeAddressLine renders them as the final
	// segment "REGION postcode" (space-joined); an older vintage emitted "REGION",
	// "postcode" as two comma segments.
	let last = segments[segments.length - 1];
	if (normalizePostcode(last)) {
		out.postcode = last;
		segments.pop();
		last = segments[segments.length - 1] ?? '';
	} else {
		const m = last.match(TRAILING_POSTCODE);
		if (m && normalizePostcode(m[2])) {
			out.postcode = m[2].replace(/\s+/g, ' ').trim();
			last = m[1].trim();
			segments[segments.length - 1] = last;
		}
	}
	if (last && normalizeRegion(last)) {
		out.region = last;
		segments.pop();
	}

	// What's left is `street, city` (composeAddressLine order). A lone remaining
	// segment is the street — the part create_locations requires.
	if (segments.length >= 2) {
		out.street = segments[0];
		out.city = segments.slice(1).join(', ');
	} else if (segments.length === 1) {
		out.street = segments[0];
	}

	return Object.keys(out).length ? out : undefined;
}

/**
 * The best structured address parts a staged POI can offer, merged per part in
 * provenance order: the POI's own `addr:*` tags, then parts recovered from its
 * enriched single-line address (containing building / Overture), then the
 * extract-time admin-boundary join for city/region (see osm/enrich-admin.ts).
 * This is what create_locations/import_chain resolve an `osm_id` import against,
 * and what search_poi advertises — so a candidate's `address_parts` always show
 * exactly what an import would store. Undefined when no source has any part.
 * Values are raw (as the source wrote them); the MCP server normalizes them.
 */
export function effectivePoiAddressParts(poi: {
	tags_json: string;
	address: string | null;
	admin_city: string | null;
	admin_region: string | null;
}): PoiAddressParts | undefined {
	const own = osmOwnAddressParts(poi.tags_json) ?? {};
	const line = addressPartsFromLine(poi.address) ?? {};
	const out: PoiAddressParts = {};
	const street = own.street ?? line.street;
	const city = own.city ?? line.city ?? poi.admin_city ?? undefined;
	const region = own.region ?? line.region ?? poi.admin_region ?? undefined;
	const postcode = own.postcode ?? line.postcode;
	const country = own.country ?? line.country;
	if (street) out.street = street;
	if (city) out.city = city;
	if (region) out.region = region;
	if (postcode) out.postcode = postcode;
	if (country) out.country = country;
	return Object.keys(out).length ? out : undefined;
}

/** Venue-level dietary markers OSM explicitly asserts (`diet:x=yes|only`), mapped to tag ids. */
export function dietMarkers(props: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [key, tag] of Object.entries(DIET_KEY_TO_TAG)) {
		const val = props[key];
		if (val === 'yes' || val === 'only') out.push(tag);
	}
	return out;
}

/** Recursively collects every [lon, lat] position from a GeoJSON coordinates value. */
function collectPositions(coords: unknown, out: number[][]): void {
	if (!Array.isArray(coords)) return;
	if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
		out.push([coords[0], coords[1]]);
		return;
	}
	for (const c of coords) collectPositions(c, out);
}

/**
 * A representative [lon, lat] point for any geometry: the point itself for a
 * Point, otherwise the centroid (mean of vertices) — good enough to drop a
 * marker for a restaurant mapped as a building footprint.
 */
export function representativePoint(
	geometry: { type: string; coordinates: unknown } | null | undefined
): [number, number] | null {
	if (!geometry) return null;
	if (geometry.type === 'Point') {
		const c = geometry.coordinates;
		if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
			return [c[0], c[1]];
		}
		return null;
	}
	const positions: number[][] = [];
	collectPositions(geometry.coordinates, positions);
	if (positions.length === 0) return null;
	const sum = positions.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
	return [sum[0] / positions.length, sum[1] / positions.length];
}

interface ParsedId {
	/** Canonical id keyed by original OSM type, e.g. "n123" / "w456" / "r789". */
	osm_id: string;
	osm_type: PoiRow['osm_type'];
	numeric_id: number;
}

/**
 * Parses osmium's prefixed unique id (from `osmium export -u type_id`):
 *   • "n123" → node 123
 *   • "w456" → way 456 (open way exported as a linestring)
 *   • "r789" → relation 789
 *   • "a…"   → an AREA. osmium encodes area ids as `way_id*2` (even) or
 *              `relation_id*2+1` (odd), so we decode back to the underlying
 *              way/relation — that's what openstreetmap.org URLs need.
 * A bare numeric id is assumed to be a node.
 */
export function parseOsmId(raw: string | number | undefined): ParsedId | null {
	if (raw === undefined || raw === null) return null;
	const s = String(raw).trim();
	if (!s) return null;

	const prefix = s[0].toLowerCase();
	const rest = Number(s.slice(1));

	if (prefix === 'n' || prefix === 'w' || prefix === 'r') {
		if (!Number.isFinite(rest)) return null;
		const osm_type = prefix === 'n' ? 'node' : prefix === 'w' ? 'way' : 'relation';
		return { osm_id: `${prefix}${rest}`, osm_type, numeric_id: rest };
	}

	if (prefix === 'a') {
		if (!Number.isFinite(rest)) return null;
		if (rest % 2 === 0) {
			const id = rest / 2;
			return { osm_id: `w${id}`, osm_type: 'way', numeric_id: id };
		}
		const id = (rest - 1) / 2;
		return { osm_id: `r${id}`, osm_type: 'relation', numeric_id: id };
	}

	const numeric = Number(s);
	if (!Number.isFinite(numeric)) return null;
	return { osm_id: `n${numeric}`, osm_type: 'node', numeric_id: numeric };
}

/**
 * Maps one OSM GeoJSON feature to a {@link PoiRow}, or null if it is not a food
 * POI we recognise (wrong/absent class, no id, or no usable geometry).
 */
export function mapFeature(feature: OsmFeature): PoiRow | null {
	const props = feature.properties;
	if (!props) return null;

	const osmClass = classOf(props);
	if (!osmClass) return null;

	// Drop venues OSM marks as closed/disused so they never reach search_poi.
	if (isClosed(props)) return null;

	const id = parseOsmId(props['@id'] ?? feature.id);
	if (!id) return null;

	const point = representativePoint(feature.geometry);
	if (!point) return null;
	const [longitude, latitude] = point;

	return {
		osm_id: id.osm_id,
		osm_type: id.osm_type,
		numeric_id: id.numeric_id,
		name: blankToNull(props.name),
		osm_class: osmClass,
		suggested_category: suggestedCategory(osmClass),
		cuisine: blankToNull(props.cuisine),
		latitude,
		longitude,
		address: composeAddress(props),
		phone: blankToNull(props.phone ?? props['contact:phone']),
		website: blankToNull(props.website ?? props['contact:website']),
		opening_hours: blankToNull(props.opening_hours),
		diet_markers: dietMarkers(props),
		tags_json: JSON.stringify(props),
		admin_city: null,
		admin_region: null
	};
}

/** Builds the canonical openstreetmap.org URL for a POI (for citing as a source). */
export function osmUrl(osmType: PoiRow['osm_type'], numericId: number): string {
	return `https://www.openstreetmap.org/${osmType}/${numericId}`;
}
