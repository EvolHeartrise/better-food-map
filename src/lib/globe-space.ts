// Project points floating in the 3D space AROUND the globe to screen pixels.
//
// This is how the landing's coverage figures get true 3D positions in the void
// around the zoomed-out globe: each is anchored at a direction (a unit vector from
// the globe centre) and a `radius` > 1 (1 = on the surface, larger = further out
// into space), and this projects it through MapLibre's *own* globe camera so the
// perspective, parallax and occlusion match the rendered globe exactly.
//
// It reads two undocumented (`@internal`) fields off the active globe transform —
// the same class of private access the map already relies on for label occlusion
// (`isLocationOccluded` in LocationMap): the view-projection matrix that maps a
// unit-sphere vector to clip space (`_globeViewProjMatrixNoCorrection`, the
// "no correction" matrix MapLibre itself keeps for accurate CPU-side math) and
// the horizon clipping plane (`_cachedClippingPlane`) — whose normal is the
// camera axis (points at the viewer) and whose sign tells front-of-globe from
// behind-it. Both are probed defensively: if a future maplibre-gl renames them, or
// the camera has flattened to Mercator when zoomed in (no globe, fields absent),
// the functions return null and the caller just hides the figures — it degrades,
// never throws. Derived from maplibre-gl 5.24's
// `VerticalPerspectiveTransform.projectTileCoordinates`.

import type { Map as MapLibreMap } from 'maplibre-gl';

export type Vec3 = [number, number, number];

export type SpacePoint = {
	// Screen position in CSS pixels (same space as `map.project`).
	x: number;
	y: number;
	// Perspective size cue: > 1 when nearer the camera than the globe centre, < 1 further.
	scale: number;
	// 1 on the camera-facing hemisphere, ramping to 0 as the point passes behind the
	// globe (a DOM element can't render behind the canvas, so the caller fades it out).
	visibility: number;
};

type GlobeInternals = {
	m: ArrayLike<number>; // _globeViewProjMatrixNoCorrection
	plane: ArrayLike<number>; // _cachedClippingPlane
};

type MaybeGlobe = {
	currentTransform?: {
		_globeViewProjMatrixNoCorrection?: ArrayLike<number>;
		_cachedClippingPlane?: ArrayLike<number>;
	};
	_globeViewProjMatrixNoCorrection?: ArrayLike<number>;
	_cachedClippingPlane?: ArrayLike<number>;
};

function globeInternals(map: MapLibreMap): GlobeInternals | null {
	// The globe transform is a facade that swaps between a Mercator and a
	// vertical-perspective transform by zoom; the matrices live on the active inner
	// one when a globe is being drawn.
	const tr = map.transform as unknown as MaybeGlobe;
	const inner = tr.currentTransform ?? tr;
	const m = inner._globeViewProjMatrixNoCorrection;
	const plane = inner._cachedClippingPlane;
	if (!m || !plane) return null;
	return { m, plane };
}

// The unit axis from the globe centre toward the camera (the clipping-plane normal),
// i.e. the direction of the point at the centre of the visible disc. Null when off-globe.
export function getCameraAxis(map: MapLibreMap): Vec3 | null {
	const g = globeInternals(map);
	if (!g) return null;
	const p = g.plane;
	const len = Math.hypot(p[0], p[1], p[2]) || 1;
	return [p[0] / len, p[1] / len, p[2] / len];
}

// The globe's disc on screen: centre in CSS pixels and radius. Lets the caller keep
// the floating figures OUT of the disc (in the void) rather than over the map tiles.
export function getGlobeScreen(
	map: MapLibreMap
): { cx: number; cy: number; radius: number } | null {
	const g = globeInternals(map);
	if (!g) return null;
	const { m } = g;
	const w = map.transform.width;
	const h = map.transform.height;
	// Globe centre = the origin (0,0,0) through the matrix.
	const cw = m[15];
	if (cw <= 0) return null;
	const cx = (m[12] / cw / 2 + 0.5) * w;
	const cy = (0.5 - m[13] / cw / 2) * h;
	// Radius = screen distance from the centre to a point on the limb. The camera axis
	// is the clipping-plane normal; any unit vector perpendicular to it lands on the limb.
	const axis = getCameraAxis(map);
	if (!axis) return null;
	const worldUp: Vec3 = Math.abs(axis[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
	const limb = normalize(cross(worldUp, axis));
	const p = projectSpaceVector(map, limb, 1);
	if (!p) return null;
	return { cx, cy, radius: Math.hypot(p.x - cx, p.y - cy) };
}

// Project a unit direction pushed out to `radius` (1 = surface, > 1 = into the void).
export function projectSpaceVector(map: MapLibreMap, dir: Vec3, radius: number): SpacePoint | null {
	const g = globeInternals(map);
	if (!g) return null;
	const { m, plane } = g;
	const [dx, dy, dz] = dir;
	const px = dx * radius;
	const py = dy * radius;
	const pz = dz * radius;

	// clip = M · (px, py, pz, 1) — column-major mat4 (gl-matrix layout).
	const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
	const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
	const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
	if (cw <= 0) return null; // behind the camera

	const ndcX = cx / cw;
	const ndcY = cy / cw;
	const x = (ndcX * 0.5 + 0.5) * map.transform.width;
	const y = (0.5 - ndcY * 0.5) * map.transform.height;

	// Signed distance from the globe's horizon plane, using the surface direction as
	// MapLibre does: > 0 faces the camera, < 0 is the far hemisphere (behind the globe).
	const planeLen = Math.hypot(plane[0], plane[1], plane[2]) || 1;
	const sd = (plane[0] * dx + plane[1] * dy + plane[2] * dz + plane[3]) / planeLen;
	const band = 0.06; // soft fade width across the limb, in sphere-radius units
	const visibility = clamp((sd + band) / (2 * band), 0, 1);
	if (visibility <= 0) return { x, y, scale: 1, visibility: 0 };

	// M[15] is w at the globe centre (the origin), so this is 1 there and grows as the
	// point nears the camera — a subtle perspective size cue on top of the parallax.
	const centerW = m[15] || cw;
	const scale = clamp(centerW / cw, 0.7, 1.4);

	return { x, y, scale, visibility };
}

// --- Small vec3 helpers (unit inputs assumed where noted) -------------------
export function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(v: Vec3): Vec3 {
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}
