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
