import { test, expect } from 'bun:test';
import { haversineMeters, bboxAround } from './geo';

test('haversineMeters is zero for the same point', () => {
	expect(haversineMeters(49.2827, -123.1207, 49.2827, -123.1207)).toBe(0);
});

test('haversineMeters ~ 111 m for 0.001 deg of latitude', () => {
	const d = haversineMeters(49.2827, -123.1207, 49.2837, -123.1207);
	expect(d).toBeGreaterThan(105);
	expect(d).toBeLessThan(116);
});

test('bboxAround contains the centre and is roughly symmetric', () => {
	const lat = 49.2827;
	const lon = -123.1207;
	const box = bboxAround(lat, lon, 1); // 1 km
	expect(box.minLat).toBeLessThan(lat);
	expect(box.maxLat).toBeGreaterThan(lat);
	expect(box.minLon).toBeLessThan(lon);
	expect(box.maxLon).toBeGreaterThan(lon);
	// ~1 km north of centre should sit inside the box's latitude span.
	const northEdge = haversineMeters(lat, lon, box.maxLat, lon);
	expect(northEdge).toBeGreaterThan(950);
	expect(northEdge).toBeLessThan(1100);
});

test('bboxAround clamps longitude span at high latitude without blowing up', () => {
	const box = bboxAround(89.9, 0, 10);
	expect(Number.isFinite(box.minLon)).toBe(true);
	expect(Number.isFinite(box.maxLon)).toBe(true);
	expect(box.maxLat).toBeLessThanOrEqual(90);
});
