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

/** Composes a single-line address from OSM `addr:*` tags (null if none present). */
export function composeAddress(props: Record<string, string>): string | null {
	const houseAndStreet = [props['addr:housenumber'], props['addr:street']]
		.filter(Boolean)
		.join(' ');
	const region = props['addr:state'] ?? props['addr:province'];
	const parts = [houseAndStreet, props['addr:city'], region, props['addr:postcode']].filter(
		(p): p is string => Boolean(p && p.trim())
	);
	return parts.length ? parts.join(', ') : null;
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

/** Trims and collapses whitespace; returns null for empty/whitespace-only input. */
function clean(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.replace(/\s+/g, ' ').trim();
	return trimmed.length ? trimmed : null;
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

	const id = parseOsmId(props['@id'] ?? feature.id);
	if (!id) return null;

	const point = representativePoint(feature.geometry);
	if (!point) return null;
	const [longitude, latitude] = point;

	return {
		osm_id: id.osm_id,
		osm_type: id.osm_type,
		numeric_id: id.numeric_id,
		name: clean(props.name),
		osm_class: osmClass,
		suggested_category: suggestedCategory(osmClass),
		cuisine: clean(props.cuisine),
		latitude,
		longitude,
		address: composeAddress(props),
		phone: clean(props.phone ?? props['contact:phone']),
		website: clean(props.website ?? props['contact:website']),
		opening_hours: clean(props.opening_hours),
		diet_markers: dietMarkers(props),
		tags_json: JSON.stringify(props)
	};
}

/** Builds the canonical openstreetmap.org URL for a POI (for citing as a source). */
export function osmUrl(osmType: PoiRow['osm_type'], numericId: number): string {
	return `https://www.openstreetmap.org/${osmType}/${numericId}`;
}
