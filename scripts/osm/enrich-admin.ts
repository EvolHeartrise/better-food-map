// ---------------------------------------------------------------------------
// Admin-area enrichment for OSM food POIs.
//
// Only ~30% of OSM food POIs carry their own `addr:city`, and building/Overture
// address enrichment mostly recovers the street line — so most staged POIs used
// to reach create_locations with no city/region, forcing the importing agent to
// reverse-geocode by hand (rate-limited, slow, and off-policy). This module
// closes that gap at extract time: given a region's food rows and a stream of
// OSM administrative boundary polygons (`osmium tags-filter r/boundary=administrative`
// + export), it assigns every row the municipality (admin_level 6–8, most
// specific wins) and province/state (admin_level 4) that CONTAIN it — verbatim
// OSM admin context, never geocoded.
//
// Point-in-polygon at this scale needs indexing: a coastal province's boundary
// ring carries ~10^6 vertices, and naive ray-casting per POI would take hours.
// IndexedRings bins every ring edge by latitude band once per boundary, so each
// containment test only walks the edges whose latitude span crosses the query
// point (even-odd parity across ALL rings, which handles holes and multipolygons
// without tracking which ring is which).
//
// Pure/deterministic and Bun-agnostic — unit-tested in enrich-admin.test.ts.
// The streaming wiring lives in scripts/osm-extract.ts.
// ---------------------------------------------------------------------------

import { normalizeRegion } from '../../src/lib/address';
import { SpatialGrid, type Bounds } from './geo';
import type { PoiRow } from './map-feature';

/** One administrative boundary parsed from a geojsonseq line. */
export interface AdminBoundary {
	name: string;
	/** OSM admin_level: 4 = province/state, 6–8 = county/district/municipality. */
	adminLevel: number;
	/** Every ring (outer and hole alike) as a [lon, lat] vertex list. */
	rings: number[][][];
}

/** admin_level 4 is the region tier; 6–8 the city tier (9/10 districts are too fine). */
const REGION_LEVEL = 4;
const CITY_LEVELS = new Set([6, 7, 8]);

/**
 * The preference weight of a city-tier admin_level — a municipality (8) beats a
 * district (7) beats a county/regional district (6), regardless of area, so
 * "Vancouver" wins over "Metro Vancouver Regional District". Lower is better.
 */
const CITY_LEVEL_WEIGHT: Record<number, number> = { 8: 0, 7: 1, 6: 2 };

/** Minimal shape of a GeoJSON feature line; coordinates are validated structurally at use. */
interface RawFeature {
	geometry?: { type?: string; coordinates?: unknown } | null;
	properties?: Record<string, string> | null;
}

/**
 * Parses one `osmium export -f geojsonseq` line into an {@link AdminBoundary},
 * or null when it is not a named administrative polygon at a level we use.
 * Never throws — one bad line must not abort a load. Leading control chars
 * (RFC 8142 record separator U+001E) are stripped first.
 */
export function parseAdminBoundary(line: string): AdminBoundary | null {
	let start = 0;
	while (start < line.length && line.charCodeAt(start) < 0x20) start++;
	const trimmed = line.slice(start).trim();
	// Cheap rejects before the (relatively costly) JSON.parse: only administrative
	// polygons matter, and osmium emits areas as "Polygon"/"MultiPolygon".
	if (!trimmed || !trimmed.includes('Polygon') || !trimmed.includes('administrative')) return null;

	let feature: RawFeature;
	try {
		feature = JSON.parse(trimmed) as RawFeature;
	} catch {
		return null;
	}

	const props = feature.properties;
	if (!props || props.boundary !== 'administrative' || !props.name?.trim()) return null;
	const adminLevel = Number(props.admin_level);
	if (adminLevel !== REGION_LEVEL && !CITY_LEVELS.has(adminLevel)) return null;

	const geometry = feature.geometry;
	if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
	const coords = geometry.coordinates as number[][][] | number[][][][];
	const polygons = (geometry.type === 'Polygon' ? [coords] : coords) as number[][][][];
	const rings: number[][][] = [];
	for (const poly of polygons) for (const ring of poly) if (ring.length >= 3) rings.push(ring);
	if (!rings.length) return null;

	return { name: props.name.trim(), adminLevel, rings };
}

// Latitude bands of this many degrees per index bucket. Small enough that a
// containment test against a ~10^6-edge provincial coastline only walks a few
// thousand edges; large enough that the index itself stays cheap to build.
const BIN_DEG = 0.05;

/**
 * A boundary's rings indexed for fast containment tests: every edge is binned by
 * the latitude bands it spans, and `contains` ray-casts (westward) against only
 * the edges in the query point's band. Parity is counted across ALL rings, so
 * holes and multipolygon parts need no bookkeeping (even-odd rule). Also carries
 * the boundary's bbox (to find candidate POIs) and a planar area proxy (for
 * "most specific wins" tie-breaks).
 */
export class IndexedRings {
	readonly bbox: Bounds;
	/** Planar deg² area summed over all rings — a size proxy, not a true area. */
	readonly areaProxy: number;
	private readonly minBin: number;
	/** Per latitude band, a flat [x1, y1, x2, y2, ...] edge list. */
	private readonly bins: number[][];

	constructor(rings: number[][][]) {
		let minLat = 90,
			maxLat = -90,
			minLng = 180,
			maxLng = -180,
			area = 0;
		for (const ring of rings) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [lon, lat] = ring[i];
				if (lat < minLat) minLat = lat;
				if (lat > maxLat) maxLat = lat;
				if (lon < minLng) minLng = lon;
				if (lon > maxLng) maxLng = lon;
				area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
			}
		}
		this.bbox = { minLat, maxLat, minLng, maxLng };
		this.areaProxy = Math.abs(area / 2);
		this.minBin = Math.floor(minLat / BIN_DEG);
		const binCount = Math.max(1, Math.floor(maxLat / BIN_DEG) - this.minBin + 1);
		this.bins = Array.from({ length: binCount }, () => []);

		for (const ring of rings) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const y1 = ring[j][1],
					y2 = ring[i][1];
				if (y1 === y2) continue; // horizontal edges never cross a horizontal ray
				const lo = Math.max(Math.floor(Math.min(y1, y2) / BIN_DEG) - this.minBin, 0);
				const hi = Math.min(
					Math.floor(Math.max(y1, y2) / BIN_DEG) - this.minBin,
					this.bins.length - 1
				);
				for (let b = lo; b <= hi; b++) this.bins[b].push(ring[j][0], y1, ring[i][0], y2);
			}
		}
	}

	/** Even-odd containment: parity of westward ray crossings over the point's band. */
	contains(lat: number, lon: number): boolean {
		const { bbox } = this;
		if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLng || lon > bbox.maxLng) {
			return false;
		}
		const bin = this.bins[Math.floor(lat / BIN_DEG) - this.minBin];
		if (!bin) return false;
		let inside = false;
		for (let e = 0; e < bin.length; e += 4) {
			const x1 = bin[e],
				y1 = bin[e + 1],
				x2 = bin[e + 2],
				y2 = bin[e + 3];
			if (y1 > lat !== y2 > lat && lon < ((x1 - x2) * (lat - y2)) / (y1 - y2) + x2) {
				inside = !inside;
			}
		}
		return inside;
	}
}

// Admin boundaries span whole provinces, so the candidate grid uses much larger
// cells than the building enricher's 0.01° — probing a province-sized bbox at
// 0.01° would walk millions of empty cells before finding any POIs.
const GRID_CELL_DEG = 0.5;

/**
 * Assigns every {@link PoiRow} the OSM admin areas that contain it: `admin_city`
 * from the most specific containing city-tier boundary (admin_level 8 beats 7
 * beats 6; same level → smallest area), `admin_region` from the containing
 * admin_level-4 boundary (normalized to a 2-letter code when recognized). Build
 * it once over a region's rows, `apply()` each boundary as it streams in, then
 * `finalize()` to write the winners onto the rows.
 *
 * Memory is bounded by the rows plus one boundary at a time — boundaries are
 * indexed, tested, and released.
 */
export class AdminEnricher {
	private readonly grid = new SpatialGrid(GRID_CELL_DEG);
	private readonly bestCity = new Map<number, { name: string; weight: number; area: number }>();
	private readonly bestRegion = new Map<number, { name: string; area: number }>();

	constructor(private readonly rows: PoiRow[]) {
		rows.forEach((row, i) => this.grid.insert(i, row.latitude, row.longitude));
	}

	/** Tests this boundary against every row inside its bbox, keeping the best match per row. */
	apply(boundary: AdminBoundary): void {
		const indexed = new IndexedRings(boundary.rings);
		const isRegion = boundary.adminLevel === REGION_LEVEL;
		const weight = CITY_LEVEL_WEIGHT[boundary.adminLevel] ?? Number.MAX_SAFE_INTEGER;
		for (const idx of this.grid.candidatesInBbox(indexed.bbox)) {
			const row = this.rows[idx];
			if (isRegion) {
				// A row normally sits in exactly one level-4 area; overlapping claims
				// (border quirks) resolve to the smaller one.
				const prev = this.bestRegion.get(idx);
				if (prev && prev.area <= indexed.areaProxy) continue;
				if (indexed.contains(row.latitude, row.longitude)) {
					this.bestRegion.set(idx, { name: boundary.name, area: indexed.areaProxy });
				}
				continue;
			}
			const prev = this.bestCity.get(idx);
			if (
				prev &&
				(prev.weight < weight || (prev.weight === weight && prev.area <= indexed.areaProxy))
			) {
				continue;
			}
			if (indexed.contains(row.latitude, row.longitude)) {
				this.bestCity.set(idx, { name: boundary.name, weight, area: indexed.areaProxy });
			}
		}
	}

	/** Writes the winning admin areas onto the rows; returns how many got each. */
	finalize(): { cities: number; regions: number } {
		for (const [idx, match] of this.bestCity) this.rows[idx].admin_city = match.name;
		for (const [idx, match] of this.bestRegion) {
			// Store the 2-letter code when the name resolves (e.g. "British Columbia"
			// → "BC"); keep the raw name otherwise so no admin context is lost.
			this.rows[idx].admin_region = normalizeRegion(match.name) ?? match.name;
		}
		return { cities: this.bestCity.size, regions: this.bestRegion.size };
	}
}
