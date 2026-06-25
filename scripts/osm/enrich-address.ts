// ---------------------------------------------------------------------------
// Address enrichment for OSM food POIs.
//
// About half of OSM food POIs carry no `addr:*` tags of their own, so
// composeAddress() returns null for them (see map-feature.ts). But many of those
// venues sit INSIDE a building footprint that IS addressed. This module fills the
// gap: given the food rows for a region and a stream of addressed building
// polygons (from `osmium tags-filter wr/addr:housenumber` + export), it assigns
// each address-less venue the civic address of the building that CONTAINS it
// (point-in-polygon) — verbatim OSM data, no geocoding.
//
// Containment (not nearest-neighbour) is deliberate: a "nearest addressed object"
// rule borrows a neighbour's address in plazas/food courts and is wrong often
// enough to be unsafe. A venue inside an addressed footprint genuinely shares its
// civic address. When several addressed polygons contain a point (a unit inside a
// building inside a mall), the SMALLEST-area one wins as the most specific.
//
// Pure/deterministic and Bun-agnostic — unit-tested in enrich-address.test.ts.
// The streaming wiring lives in scripts/osm-extract.ts.
// ---------------------------------------------------------------------------

import { SpatialGrid } from './geo';
import { composeAddress, type PoiRow } from './map-feature';

/** An addressed building footprint parsed from one geojsonseq line. */
export interface ParsedBuilding {
	/** The composed civic address (never empty). */
	address: string;
	/** One or more polygons; each is [outerRing, ...holeRings]; each ring is [lon, lat] pairs. */
	polygons: number[][][][];
}

/** Minimal shape of a GeoJSON feature line; coordinates are validated structurally at use. */
interface RawFeature {
	geometry?: { type?: string; coordinates?: unknown } | null;
	properties?: Record<string, string> | null;
}

// ~1.1 km cells: small enough that a building's bbox spans only a handful, large
// enough that the index stays compact. Matches the grid in find_* tooling.
const CELL_DEG = 0.01;

/**
 * Parses one `osmium export -f geojsonseq` line into an addressed building, or
 * null when the line is blank, not a polygon, carries no `addr:housenumber`, or
 * has no composable address. Never throws — one bad line must not abort a load.
 * Leading control chars (RFC 8142 record separator U+001E) are stripped first.
 */
export function parseAddressedBuilding(line: string): ParsedBuilding | null {
	let start = 0;
	while (start < line.length && line.charCodeAt(start) < 0x20) start++;
	const trimmed = line.slice(start).trim();
	// Cheap reject before the (relatively costly) JSON.parse: only polygons matter,
	// and osmium emits areas as "Polygon"/"MultiPolygon" (both contain "Polygon").
	if (!trimmed || !trimmed.includes('Polygon')) return null;

	let feature: RawFeature;
	try {
		feature = JSON.parse(trimmed) as RawFeature;
	} catch {
		return null;
	}

	const geometry = feature.geometry;
	if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
	const props = feature.properties;
	if (!props || !props['addr:housenumber']) return null;
	const address = composeAddress(props);
	if (!address) return null;

	const coords = geometry.coordinates as number[][][] | number[][][][];
	const polygons = (geometry.type === 'Polygon' ? [coords] : coords) as number[][][][];
	return { address, polygons };
}

/** Ray-casting point-in-ring test (ring is a [lon, lat] vertex list). */
function inRing(lat: number, lon: number, ring: number[][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0],
			yi = ring[i][1],
			xj = ring[j][0],
			yj = ring[j][1];
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Inside a polygon = inside its outer ring and outside every hole. */
function pointInPolygon(lat: number, lon: number, poly: number[][][]): boolean {
	if (!poly.length || !inRing(lat, lon, poly[0])) return false;
	for (let h = 1; h < poly.length; h++) if (inRing(lat, lon, poly[h])) return false;
	return true;
}

/** Unsigned planar area of a ring (in deg²) — a size proxy for "smallest wins". */
function ringArea(ring: number[][]): number {
	let area = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
	}
	return Math.abs(area / 2);
}

/**
 * Assigns address-less {@link PoiRow}s the civic address of the addressed
 * building that contains them. Build it once over a region's rows, `apply()` each
 * addressed building as it streams in, then `finalize()` to write the chosen
 * addresses onto the rows.
 *
 * Memory is bounded by the number of *address-less* rows (only those are indexed);
 * buildings are processed one at a time and never retained.
 */
export class AddressEnricher {
	private readonly grid = new SpatialGrid(CELL_DEG);
	private readonly best = new Map<number, { address: string; area: number }>();

	constructor(private readonly rows: PoiRow[]) {
		rows.forEach((row, i) => {
			if (row.address && row.address.trim()) return; // already has its own address
			this.grid.insert(i, row.latitude, row.longitude);
		});
	}

	/** Records this building against every address-less row it contains (smallest-area wins). */
	apply(building: ParsedBuilding): void {
		let minLat = 90,
			maxLat = -90,
			minLon = 180,
			maxLon = -180;
		for (const poly of building.polygons)
			for (const ring of poly)
				for (const [lon, lat] of ring) {
					if (lat < minLat) minLat = lat;
					if (lat > maxLat) maxLat = lat;
					if (lon < minLon) minLon = lon;
					if (lon > maxLon) maxLon = lon;
				}

		for (const idx of this.grid.candidatesInBbox({ minLat, maxLat, minLon, maxLon })) {
			const row = this.rows[idx];
			// Score the row against the polygon that ACTUALLY contains it (a building
			// may be a MultiPolygon), not always the first — its footprint is what the
			// smallest-area "most specific address wins" tie-break must compare.
			const containing = building.polygons.find((poly) =>
				pointInPolygon(row.latitude, row.longitude, poly)
			);
			if (!containing) continue;
			const area = ringArea(containing[0]);
			const prev = this.best.get(idx);
			if (!prev || area < prev.area) this.best.set(idx, { address: building.address, area });
		}
	}

	/** Writes the chosen addresses onto the rows; returns how many were enriched. */
	finalize(): number {
		for (const [idx, match] of this.best) this.rows[idx].address = match.address;
		return this.best.size;
	}
}
