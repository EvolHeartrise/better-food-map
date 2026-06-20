/** A geographic point expressed as `[latitude, longitude]`. */
export type LatLng = [number, number];

/**
 * Ray-casting point-in-polygon test. `polygon` is an open ring of `[lat, lng]`
 * vertices — the closing edge from the last vertex back to the first is implied.
 *
 * Coordinates are treated as planar (lng = x, lat = y), which is accurate enough
 * at city scale; it does not account for the antimeridian or great-circle edges.
 * A point lying exactly on an edge may be reported either way, which is fine for
 * filtering map markers.
 */
export function pointInPolygon(point: LatLng, polygon: readonly LatLng[]): boolean {
	if (polygon.length < 3) return false;

	const [lat, lng] = point;
	let inside = false;

	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [latI, lngI] = polygon[i];
		const [latJ, lngJ] = polygon[j];

		// Does the edge (j → i) straddle the point's latitude? If so, find where
		// the edge crosses that latitude and flip `inside` when it's to our east.
		const straddles = latI > lat !== latJ > lat;
		if (straddles) {
			const lngAtLat = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
			if (lng < lngAtLat) inside = !inside;
		}
	}

	return inside;
}
