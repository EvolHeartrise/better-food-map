// The ONE geographic bounding-box shape shared across the app: the map client
// (<LocationMap>'s reported viewport), the server data layer ($lib/server/db),
// and the OSM pipeline scripts (scripts/osm/geo.ts re-exports it). Client-safe —
// no server-only imports — so components can import it without pulling server
// code into the browser bundle.

/**
 * A geographic bounding box (e.g. a map viewport). Longitudes are treated as a
 * simple `min..max` range, so a box spanning the antimeridian is not supported
 * (the same planar assumption the rest of the app makes).
 */
export interface Bounds {
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
}
