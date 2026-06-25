// ---------------------------------------------------------------------------
// Small geo helpers shared by the OSM POI extract + search code. Pure functions,
// no I/O — unit-tested in geo.test.ts. Distances are in METRES (dedup thresholds
// read more naturally that way than in km).
// ---------------------------------------------------------------------------

export interface Bbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/long points, in metres. */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = toRad(bLat - aLat);
	const dLon = toRad(bLon - aLon);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Axis-aligned bounding box covering a circle of `radiusKm` around a point.
 * Used to turn a centre+radius query into the indexed `BETWEEN` range scan the
 * staging store runs, after which callers refine by exact {@link haversineMeters}.
 * Latitude is clamped to the poles and longitude to [-180, 180]; the degenerate
 * wrap-around at the antimeridian is not handled (irrelevant for our regions).
 */
export function bboxAround(lat: number, lon: number, radiusKm: number): Bbox {
	const dLat = radiusKm / 111.32;
	// A degree of longitude shrinks toward the poles; guard the cos at very high
	// latitudes so the box stays finite.
	const cos = Math.max(Math.cos(toRad(lat)), 0.01);
	const dLon = radiusKm / (111.32 * cos);
	return {
		minLat: Math.max(lat - dLat, -90),
		maxLat: Math.min(lat + dLat, 90),
		minLon: Math.max(lon - dLon, -180),
		maxLon: Math.min(lon + dLon, 180)
	};
}

/**
 * A uniform lat/long grid index over a fixed set of points, for "which of these
 * points fall in this bbox?" queries without an O(n) scan per query. Points are
 * inserted by caller-chosen index (so the caller maps an index back to its own
 * record); {@link candidatesInBbox} streams the indices whose point lies inside a
 * query box, probing only the cells that box overlaps.
 *
 * Cells are `cellDeg` degrees on a side — pick it a touch larger than the largest
 * query box so each query probes only a handful of cells. The planar bbox match
 * mirrors the rest of this module (antimeridian wrap-around is not handled).
 * Shared by the OSM enrichment + Overture-matching passes.
 */
export class SpatialGrid {
	private readonly cells = new Map<string, { idx: number; lat: number; lon: number }[]>();

	constructor(private readonly cellDeg: number) {}

	/** Indexes a point under `index` (the caller's own row id into its record set). */
	insert(index: number, lat: number, lon: number): void {
		const key = `${Math.floor(lat / this.cellDeg)}:${Math.floor(lon / this.cellDeg)}`;
		const bucket = this.cells.get(key);
		if (bucket) bucket.push({ idx: index, lat, lon });
		else this.cells.set(key, [{ idx: index, lat, lon }]);
	}

	/** Yields the indices of every inserted point inside `bbox` (inclusive bounds). */
	*candidatesInBbox(bbox: Bbox): Iterable<number> {
		const minCy = Math.floor(bbox.minLat / this.cellDeg);
		const maxCy = Math.floor(bbox.maxLat / this.cellDeg);
		const minCx = Math.floor(bbox.minLon / this.cellDeg);
		const maxCx = Math.floor(bbox.maxLon / this.cellDeg);
		for (let cy = minCy; cy <= maxCy; cy++) {
			for (let cx = minCx; cx <= maxCx; cx++) {
				const bucket = this.cells.get(`${cy}:${cx}`);
				if (!bucket) continue;
				for (const p of bucket) {
					if (p.lat < bbox.minLat || p.lat > bbox.maxLat) continue;
					if (p.lon < bbox.minLon || p.lon > bbox.maxLon) continue;
					yield p.idx;
				}
			}
		}
	}
}
