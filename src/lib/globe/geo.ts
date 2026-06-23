// Pure geometry / projection math for the 3D tiled globe. Deliberately free of
// three.js and the DOM so it can be unit-tested in isolation (see
// scripts/globe-geo.test.ts) and reused by any renderer. Latitude/longitude are in
// DEGREES at every public boundary — matching the rest of the app's lat/lng
// contract — and converted to radians only internally.

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// The globe is modelled as a sphere of this radius centred at the origin. Every
// distance the renderer works in (camera distance, marker offsets, tile altitude)
// is expressed in these units. Kept at 1 so "distance from centre" reads directly
// as "multiples of the globe radius".
export const GLOBE_RADIUS = 1;

// Web Mercator can only project latitudes within this band (±~85.05°); slippy
// tiles don't exist beyond it, so the poles fall back to the base sphere colour.
export const MERCATOR_MAX_LAT = 85.05112877980659;

export type Vec3 = { x: number; y: number; z: number };
export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };
export type Tile = { z: number; x: number; y: number };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// --- Sphere placement -----------------------------------------------------

/**
 * lat/lng (degrees) → a point on a sphere of the given radius. The convention,
 * shared by the tile-mesh builder and marker placement so they always agree:
 * (lat 0, lng 0) sits on +X, the north pole on +Y, and (lat 0, lng 90) on −Z.
 *
 * The −Z for east is deliberate: with +X toward the camera and +Y up, east must
 * fall to the *right* of the screen (−Z is screen-right in three.js' right-handed
 * space). The naive +Z would mirror the globe east–west — text and coastlines
 * would read backwards — and would also wind the tile patches inward.
 */
export function lngLatToVector3(lng: number, lat: number, radius = GLOBE_RADIUS): Vec3 {
	const phi = lat * DEG2RAD;
	const theta = lng * DEG2RAD;
	const cosPhi = Math.cos(phi);
	return {
		x: radius * cosPhi * Math.cos(theta),
		y: radius * Math.sin(phi),
		z: -radius * cosPhi * Math.sin(theta)
	};
}

/**
 * Inverse of {@link lngLatToVector3}: a direction (it need not be unit length) →
 * its lat/lng in degrees. Used to read the sub-camera point — the spot on the
 * globe directly beneath the camera — back out of a camera position.
 */
export function vector3ToLngLat(v: Vec3): { lng: number; lat: number } {
	const r = Math.hypot(v.x, v.y, v.z) || 1;
	const lat = Math.asin(clamp(v.y / r, -1, 1)) * RAD2DEG;
	// Inverts the −Z-for-east convention in lngLatToVector3 (note the −v.z).
	const lng = Math.atan2(-v.z, v.x) * RAD2DEG;
	return { lng, lat };
}

// --- Web Mercator slippy-tile helpers -------------------------------------
// The standard OSM / Google tiling scheme: at zoom z the world is a 2^z × 2^z
// grid of tiles, x increasing east, y increasing south, with y mapped through the
// Mercator latitude projection (so equal y steps are unequal latitude steps).

/** Fractional tile X for a longitude at zoom z (may be outside [0, 2^z)). */
export function lngToTileX(lng: number, z: number): number {
	return ((lng + 180) / 360) * 2 ** z;
}

/** Fractional tile Y for a latitude at zoom z, clamped to the Mercator band. */
export function latToTileY(lat: number, z: number): number {
	const rad = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * DEG2RAD;
	return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Longitude (degrees) of a tile's west edge at integer (or fractional) x. */
export function tileXToLng(x: number, z: number): number {
	return (x / 2 ** z) * 360 - 180;
}

/**
 * Latitude (degrees) for a normalised Mercator-Y in [0, 1], where 0 is the north
 * edge of the map (+MERCATOR_MAX_LAT) and 1 is the south edge. The inverse
 * Gudermannian — used both directly and via {@link tileYToLat}.
 */
export function mercatorNormToLat(yNorm: number): number {
	const t = Math.PI - 2 * Math.PI * yNorm;
	return RAD2DEG * Math.atan(Math.sinh(t));
}

/** Latitude (degrees) of a tile's north edge at integer (or fractional) y. */
export function tileYToLat(y: number, z: number): number {
	return mercatorNormToLat(y / 2 ** z);
}

/**
 * Enumerate the tiles at zoom `z` that cover `bounds`. X wraps across the
 * antimeridian (the returned `x` is normalised into [0, 2^z) via modulo, while the
 * mesh builder re-derives the true longitude from the *unwrapped* index, so a box
 * straddling ±180° still tiles correctly). The set is hard-capped at `maxTiles`
 * by trimming the outermost rings, a defensive backstop — {@link selectZoom}
 * already keeps the natural count small.
 */
export function tilesInBounds(bounds: Bounds, z: number, maxTiles = 64): Tile[] {
	const n = 2 ** z;
	const yTop = Math.floor(latToTileY(Math.min(bounds.maxLat, MERCATOR_MAX_LAT), z));
	const yBottom = Math.floor(latToTileY(Math.max(bounds.minLat, -MERCATOR_MAX_LAT), z));
	let y0 = clamp(Math.min(yTop, yBottom), 0, n - 1);
	let y1 = clamp(Math.max(yTop, yBottom), 0, n - 1);

	// Unwrapped x indices (can be negative or ≥ n); kept unwrapped here so the
	// span across the antimeridian is contiguous, then taken modulo n per tile.
	let x0 = Math.floor(lngToTileX(bounds.minLng, z));
	let x1 = Math.floor(lngToTileX(bounds.maxLng, z));
	// A span wider than the whole world collapses to the full row.
	if (x1 - x0 + 1 >= n) {
		x0 = 0;
		x1 = n - 1;
	}

	// Trim outermost rings if the rectangle would exceed the tile budget, keeping
	// the centre of the view. Cheap and rarely hit.
	while ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles && (x1 > x0 || y1 > y0)) {
		if (x1 - x0 >= y1 - y0 && x1 > x0) {
			x0 += 1;
			x1 -= 1;
		} else if (y1 > y0) {
			y0 += 1;
			y1 -= 1;
		} else {
			break;
		}
	}

	const tiles: Tile[] = [];
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			tiles.push({ z, x: ((x % n) + n) % n, y });
		}
	}
	return tiles;
}

// --- Tile patch geometry --------------------------------------------------

export type TilePatch = {
	positions: Float32Array;
	uvs: Float32Array;
	indices: Uint16Array;
};

/**
 * Build a curved mesh patch for a single tile, draped on the sphere. The patch is
 * a `segments × segments` grid whose rows are spaced evenly in *Mercator* space
 * (not in latitude) so a tall low-zoom tile curves correctly. UVs map the tile
 * image directly: its north-west corner to image top-left.
 *
 * `altitude` lifts the patch a hair off the radius (as a fraction of it) so
 * stacked layers — base imagery vs. higher-detail tiles — don't z-fight.
 *
 * `tile.x` may be passed wrapped (in [0, 2^z)) or unwrapped: shifting longitude
 * by whole turns of 360° lands on the same 3D point, so a tile wrapped across the
 * antimeridian is still placed in the right spot.
 */
export function buildTilePatch(
	tile: Tile,
	radius = GLOBE_RADIUS,
	segments = 8,
	altitude = 0
): TilePatch {
	const n = 2 ** tile.z;
	const lngWest = tileXToLng(tile.x, tile.z);
	const lngEast = tileXToLng(tile.x + 1, tile.z);
	// Normalised Mercator-Y of the tile's north and south edges.
	const yNorthNorm = tile.y / n;
	const ySouthNorm = (tile.y + 1) / n;
	const r = radius * (1 + altitude);

	const stride = segments + 1;
	const positions = new Float32Array(stride * stride * 3);
	const uvs = new Float32Array(stride * stride * 2);

	let p = 0;
	let t = 0;
	for (let j = 0; j < stride; j++) {
		const v = j / segments;
		const lat = mercatorNormToLat(yNorthNorm + (ySouthNorm - yNorthNorm) * v);
		for (let i = 0; i < stride; i++) {
			const u = i / segments;
			const lng = lngWest + (lngEast - lngWest) * u;
			const pos = lngLatToVector3(lng, lat, r);
			positions[p++] = pos.x;
			positions[p++] = pos.y;
			positions[p++] = pos.z;
			uvs[t++] = u;
			// j = 0 is the tile's north edge, which is the image's top row; with
			// three.js' default texture flipY that maps to uv.y = 1.
			uvs[t++] = 1 - v;
		}
	}

	const indices: number[] = [];
	for (let j = 0; j < segments; j++) {
		for (let i = 0; i < segments; i++) {
			const a = j * stride + i;
			const b = a + 1;
			const c = a + stride;
			const d = c + 1;
			indices.push(a, c, b, b, c, d);
		}
	}

	return { positions, uvs, indices: new Uint16Array(indices) };
}

// --- View → data box ------------------------------------------------------

export type ViewModel = {
	bounds: Bounds;
	/** Width of the visible area in degrees of longitude (≤ 360). */
	lngSpanDeg: number;
	/** The sub-camera point — directly beneath the camera. */
	subLng: number;
	subLat: number;
	/** Angular radius of the visible spherical cap, in degrees. */
	capDeg: number;
};

/**
 * Work out the geographic area a camera can see, modelled as a spherical cap
 * around the sub-camera point. The cap radius is the smaller of the horizon (set
 * by how far out the camera is) and what the field of view actually frames (so
 * zooming in narrows the box instead of always reaching the horizon). The
 * diagonal half-FOV is used so the screen *corners* are covered, never clipped.
 *
 * Returns a lat/lng box plus the cap/zoom inputs. The box is intentionally a
 * touch generous rather than tight: the data layer pads and result-caps it
 * anyway, and over-fetching is harmless where under-fetching would drop markers
 * at the view's edge.
 */
export function computeView(params: {
	cameraPosition: Vec3;
	fovDeg: number;
	aspect: number;
	radius?: number;
}): ViewModel {
	const radius = params.radius ?? GLOBE_RADIUS;
	const d =
		Math.hypot(params.cameraPosition.x, params.cameraPosition.y, params.cameraPosition.z) / radius;
	const { lng: subLng, lat: subLat } = vector3ToLngLat(params.cameraPosition);

	const vHalf = (params.fovDeg / 2) * DEG2RAD;
	const hHalf = Math.atan(Math.tan(vHalf) * Math.max(params.aspect, 1e-6));
	// Half-angle from the view axis to a frustum corner.
	const diagHalf = Math.atan(Math.hypot(Math.tan(vHalf), Math.tan(hHalf)));

	// Horizon half-angle: arccos(R/d) — everything past it is over the edge.
	const horizon = d > 1 ? Math.acos(clamp(1 / d, -1, 1)) : 0;
	// FOV-limited half-angle: where the corner ray meets the sphere. When that ray
	// misses the sphere entirely (s ≥ 1) the whole visible disc is the horizon.
	const s = d * Math.sin(diagHalf);
	const cap = s >= 1 ? horizon : Math.min(horizon, Math.asin(s) - diagHalf);
	const capDeg = Math.max(cap, 0) * RAD2DEG;

	const minLat = clamp(subLat - capDeg, -90, 90);
	const maxLat = clamp(subLat + capDeg, -90, 90);

	const cosLat = Math.cos(subLat * DEG2RAD);
	let minLng: number;
	let maxLng: number;
	let lngSpanDeg: number;
	// Near a pole, or when the cap is wide enough to wrap, the longitude range
	// becomes the whole world — a single meridian span no longer describes it.
	if (maxLat >= 90 || minLat <= -90 || cosLat < 1e-3 || capDeg / cosLat >= 180) {
		minLng = -180;
		maxLng = 180;
		lngSpanDeg = 360;
	} else {
		const dLng = capDeg / cosLat;
		minLng = subLng - dLng;
		maxLng = subLng + dLng;
		lngSpanDeg = 2 * dLng;
	}

	return { bounds: { minLat, maxLat, minLng, maxLng }, lngSpanDeg, subLng, subLat, capDeg };
}

/**
 * Choose the slippy zoom whose tiles best fit the visible width, tying on-globe
 * tile resolution (and the zoom reported to the data layer) to how much of the
 * world is on screen: the whole globe → a low zoom, a small patch → a high one.
 * Aims for roughly `tilesAcross` tiles spanning the view horizontally.
 */
export function selectZoom(
	lngSpanDeg: number,
	opts: { tilesAcross: number; minZoom: number; maxZoom: number }
): number {
	const span = clamp(lngSpanDeg, 0.0005, 360);
	const z = Math.log2((360 / span) * opts.tilesAcross);
	return clamp(Math.round(z), opts.minZoom, opts.maxZoom);
}

/**
 * Grow a box by `padding` (a fraction of each span) on every side, so markers
 * just off screen are already loaded when the user nudges the globe and small
 * moves don't trigger a refetch. Latitude is clamped to the valid range;
 * longitude is left unclamped (the data layer treats it as a planar span).
 */
export function padBounds(bounds: Bounds, padding: number): Bounds {
	const padLat = (bounds.maxLat - bounds.minLat) * padding;
	const padLng = (bounds.maxLng - bounds.minLng) * padding;
	return {
		minLat: Math.max(-90, bounds.minLat - padLat),
		maxLat: Math.min(90, bounds.maxLat + padLat),
		minLng: bounds.minLng - padLng,
		maxLng: bounds.maxLng + padLng
	};
}

// --- Spherical camera interpolation (fly-to) ------------------------------

/**
 * Geometric slerp between two camera positions around the globe: the direction is
 * spherically interpolated (so the camera arcs over the surface rather than
 * cutting through the planet) while the distance is interpolated linearly.
 * `t` is the eased progress in [0, 1].
 */
export function slerpCamera(from: Vec3, to: Vec3, t: number): Vec3 {
	const fromLen = Math.hypot(from.x, from.y, from.z) || 1;
	const toLen = Math.hypot(to.x, to.y, to.z) || 1;
	const fx = from.x / fromLen;
	const fy = from.y / fromLen;
	const fz = from.z / fromLen;
	const tx = to.x / toLen;
	const ty = to.y / toLen;
	const tz = to.z / toLen;

	const dot = clamp(fx * tx + fy * ty + fz * tz, -1, 1);
	const omega = Math.acos(dot);
	const dist = fromLen + (toLen - fromLen) * t;

	let dx: number;
	let dy: number;
	let dz: number;
	if (omega < 1e-4) {
		// Directions essentially coincide — a plain lerp avoids the 0/0 below.
		dx = fx + (tx - fx) * t;
		dy = fy + (ty - fy) * t;
		dz = fz + (tz - fz) * t;
	} else {
		const sinOmega = Math.sin(omega);
		const a = Math.sin((1 - t) * omega) / sinOmega;
		const b = Math.sin(t * omega) / sinOmega;
		dx = a * fx + b * tx;
		dy = a * fy + b * ty;
		dz = a * fz + b * tz;
	}
	const dirLen = Math.hypot(dx, dy, dz) || 1;
	return { x: (dx / dirLen) * dist, y: (dy / dirLen) * dist, z: (dz / dirLen) * dist };
}

// --- Drag sensitivity -----------------------------------------------------

/**
 * The OrbitControls `rotateSpeed` that makes a drag track the cursor at a given
 * camera distance, so the grabbed point on the globe stays under the pointer.
 *
 * three's OrbitControls rotates by 2π·rotateSpeed radians per viewport-height of
 * drag (it normalises both axes by clientHeight). To keep a surface point under
 * the cursor, a one-pixel drag must rotate the globe by the angle that slides that
 * point one pixel across the screen. Near the sub-camera point — distance d − R
 * from the camera — a rotation dθ moves the surface tangentially by R·dθ,
 * subtending R·dθ/(d − R) at the camera, while one screen pixel subtends
 * 2·tan(fov/2)/H. Equating the per-pixel rotation with the per-pixel cursor angle
 * and cancelling the viewport height H:
 *
 *   2π·rotateSpeed / H = 2·tan(fov/2)·(d − R) / (H·R)
 *   rotateSpeed = (d − R)·tan(fov/2) / (π·R)
 *
 * Sensitivity therefore scales with how far out the camera is — tiny when zoomed
 * in (a small drag nudges the globe), large when zoomed out — whereas a fixed
 * rotateSpeed is only right at one end. (The same value serves both axes: for a
 * square-pixel perspective camera the per-pixel angular density is equal
 * horizontally and vertically.)
 */
export function rotateSpeedForDistance(
	distance: number,
	fovDeg: number,
	radius = GLOBE_RADIUS
): number {
	const altitude = Math.max(distance - radius, 0);
	return (altitude * Math.tan((fovDeg / 2) * DEG2RAD)) / (Math.PI * radius);
}
