/// <reference types="bun-types" />
// Exercises the pure globe math in src/lib/globe/geo.ts — the lat/lng ↔ sphere
// projection, Web Mercator tile helpers, the tile patch builder, and the
// camera-view → data-box model the renderer reports to the data layer. All of it
// is plain math with no three.js/DOM, so it runs directly under `bun test`.

import { test, expect } from 'bun:test';
import {
	lngLatToVector3,
	vector3ToLngLat,
	lngToTileX,
	latToTileY,
	tileXToLng,
	tileYToLat,
	mercatorNormToLat,
	tilesInBounds,
	buildTilePatch,
	computeView,
	selectZoom,
	padBounds,
	slerpCamera,
	GLOBE_RADIUS,
	MERCATOR_MAX_LAT
} from '../src/lib/globe/geo';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('lngLatToVector3 places the canonical axes', () => {
	// (0,0) → +X, north pole → +Y, (90,0) → +Z.
	const origin = lngLatToVector3(0, 0);
	near(origin.x, 1);
	near(origin.y, 0);
	near(origin.z, 0);

	const pole = lngLatToVector3(0, 90);
	near(pole.y, 1);
	near(Math.hypot(pole.x, pole.z), 0, 1e-9);

	const east = lngLatToVector3(90, 0);
	near(east.z, 1);
	near(east.x, 0, 1e-9);
});

test('lngLatToVector3 / vector3ToLngLat round-trip', () => {
	for (const [lng, lat] of [
		[0, 0],
		[-123.1207, 49.2827],
		[151.21, -33.87],
		[179, 12],
		[-45, -60]
	]) {
		const back = vector3ToLngLat(lngLatToVector3(lng, lat));
		near(back.lng, lng, 1e-6);
		near(back.lat, lat, 1e-6);
	}
	// Radius scales the vector but not the recovered angles.
	const scaled = lngLatToVector3(30, 20, 5);
	near(Math.hypot(scaled.x, scaled.y, scaled.z), 5, 1e-9);
	near(vector3ToLngLat(scaled).lat, 20, 1e-6);
});

test('web mercator tile helpers match known values', () => {
	// At z0 the single tile spans the whole world; its north edge is the Mercator
	// latitude limit and west edge is -180°.
	near(tileXToLng(0, 0), -180);
	near(tileXToLng(1, 0), 180);
	near(tileYToLat(0, 0), MERCATOR_MAX_LAT, 1e-9);
	near(tileYToLat(1, 0), -MERCATOR_MAX_LAT, 1e-9);

	// The equator/prime-meridian sits at the centre of the z1 grid.
	near(lngToTileX(0, 1), 1);
	near(latToTileY(0, 1), 1);

	// mercatorNormToLat is the inverse used by the patch builder.
	near(mercatorNormToLat(0), MERCATOR_MAX_LAT, 1e-9);
	near(mercatorNormToLat(0.5), 0, 1e-9);
});

test('tilesInBounds covers a small box and respects the budget', () => {
	const box = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 };
	const tiles = tilesInBounds(box, 12);
	expect(tiles.length).toBeGreaterThan(0);
	// Every tile is a valid index within the z12 grid and at the requested zoom.
	const n = 2 ** 12;
	for (const tile of tiles) {
		expect(tile.z).toBe(12);
		expect(tile.x).toBeGreaterThanOrEqual(0);
		expect(tile.x).toBeLessThan(n);
		expect(tile.y).toBeGreaterThanOrEqual(0);
		expect(tile.y).toBeLessThan(n);
	}
	// The tile under the box centre is present.
	const cx = ((Math.floor(lngToTileX(-123.1, 12)) % n) + n) % n;
	const cy = Math.floor(latToTileY(49.25, 12));
	expect(tiles.some((t) => t.x === cx && t.y === cy)).toBe(true);

	// A whole-world box at z4 is capped (16×16 = 256 tiles would blow the budget).
	const world = tilesInBounds({ minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 }, 4, 64);
	expect(world.length).toBeLessThanOrEqual(64);
});

test('tilesInBounds wraps across the antimeridian', () => {
	// A box straddling ±180° should yield tiles on both edges of the grid.
	const n = 2 ** 4;
	const tiles = tilesInBounds({ minLat: -10, maxLat: 10, minLng: 170, maxLng: 190 }, 4);
	const xs = new Set(tiles.map((t) => t.x));
	expect(xs.has(n - 1)).toBe(true); // just west of +180
	expect(xs.has(0)).toBe(true); // just east of -180 (wrapped)
});

test('buildTilePatch produces a grid draped on the sphere', () => {
	const segments = 4;
	const patch = buildTilePatch({ z: 1, x: 0, y: 0 }, GLOBE_RADIUS, segments);
	const stride = segments + 1;
	expect(patch.positions.length).toBe(stride * stride * 3);
	expect(patch.uvs.length).toBe(stride * stride * 2);
	expect(patch.indices.length).toBe(segments * segments * 6);

	// Every vertex sits on the sphere of the given radius.
	for (let i = 0; i < patch.positions.length; i += 3) {
		near(Math.hypot(patch.positions[i], patch.positions[i + 1], patch.positions[i + 2]), 1, 1e-6);
	}
	// The north-west corner vertex maps to image top-left (uv 0,1).
	near(patch.uvs[0], 0);
	near(patch.uvs[1], 1);

	// altitude lifts the patch off the surface.
	const lifted = buildTilePatch({ z: 1, x: 0, y: 0 }, GLOBE_RADIUS, segments, 0.01);
	near(Math.hypot(lifted.positions[0], lifted.positions[1], lifted.positions[2]), 1.01, 1e-6);
});

test('computeView: far camera sees a wide cap, close camera a narrow one', () => {
	const fovDeg = 45;
	const aspect = 1;
	// Camera straight above (0,0) — sub-camera point is the prime meridian origin.
	const far = computeView({ cameraPosition: { x: 4, y: 0, z: 0 }, fovDeg, aspect });
	near(far.subLng, 0, 1e-6);
	near(far.subLat, 0, 1e-6);

	const close = computeView({ cameraPosition: { x: 1.05, y: 0, z: 0 }, fovDeg, aspect });
	// Closer in frames a much smaller area.
	expect(close.capDeg).toBeLessThan(far.capDeg);
	expect(close.lngSpanDeg).toBeLessThan(far.lngSpanDeg);
	// Cap never exceeds the horizon (arccos(1/d)).
	const horizon = Math.acos(1 / 4) * (180 / Math.PI);
	expect(far.capDeg).toBeLessThanOrEqual(horizon + 1e-6);
});

test('computeView: a near-overhead pole view widens longitude to the whole world', () => {
	// Camera over the north pole — the visible cap includes the pole, so a single
	// longitude span can't describe it and the box opens to ±180°.
	const view = computeView({ cameraPosition: { x: 0, y: 1.2, z: 0 }, fovDeg: 60, aspect: 1.6 });
	expect(view.bounds.minLng).toBe(-180);
	expect(view.bounds.maxLng).toBe(180);
	expect(view.bounds.maxLat).toBe(90);
});

test('selectZoom is monotonic and clamped', () => {
	const opts = { tilesAcross: 2.5, minZoom: 1, maxZoom: 19 };
	const whole = selectZoom(360, opts);
	const region = selectZoom(10, opts);
	const street = selectZoom(0.2, opts);
	expect(whole).toBeLessThan(region);
	expect(region).toBeLessThan(street);
	expect(whole).toBeGreaterThanOrEqual(1);
	expect(street).toBeLessThanOrEqual(19);
});

test('padBounds grows the box and clamps latitude', () => {
	const padded = padBounds({ minLat: 10, maxLat: 20, minLng: 30, maxLng: 50 }, 0.2);
	near(padded.minLat, 8);
	near(padded.maxLat, 22);
	near(padded.minLng, 26);
	near(padded.maxLng, 54);

	const clamped = padBounds({ minLat: -88, maxLat: 88, minLng: 0, maxLng: 10 }, 0.5);
	expect(clamped.minLat).toBe(-90);
	expect(clamped.maxLat).toBe(90);
});

test('slerpCamera arcs over the sphere at endpoints and midpoint', () => {
	const from = lngLatToVector3(0, 0, 2);
	const to = lngLatToVector3(90, 0, 3);
	// Endpoints are returned exactly (distance and direction).
	const start = slerpCamera(from, to, 0);
	near(Math.hypot(start.x, start.y, start.z), 2, 1e-6);
	const end = slerpCamera(from, to, 1);
	near(Math.hypot(end.x, end.y, end.z), 3, 1e-6);
	near(vector3ToLngLat(end).lng, 90, 1e-6);

	// Midpoint sits between the two longitudes, at the interpolated distance.
	const mid = slerpCamera(from, to, 0.5);
	near(Math.hypot(mid.x, mid.y, mid.z), 2.5, 1e-6);
	const midLng = vector3ToLngLat(mid).lng;
	expect(midLng).toBeGreaterThan(0);
	expect(midLng).toBeLessThan(90);
});
