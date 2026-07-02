import { test, expect } from 'bun:test';
import { parseAdminBoundary, AdminEnricher, IndexedRings } from './enrich-admin';
import type { PoiRow } from './map-feature';

/** Minimal PoiRow factory — only the fields admin enrichment reads/writes matter here. */
function poi(over: Partial<PoiRow> & Pick<PoiRow, 'osm_id' | 'latitude' | 'longitude'>): PoiRow {
	return {
		osm_type: 'node',
		numeric_id: 1,
		name: null,
		osm_class: 'restaurant',
		suggested_category: 'restaurant',
		cuisine: null,
		address: null,
		phone: null,
		website: null,
		opening_hours: null,
		diet_markers: [],
		tags_json: '{}',
		admin_city: null,
		admin_region: null,
		...over
	};
}

/** A square ring centred on (lat, lon) with half-size `h` deg (closed, CCW). */
function squareRing(lat: number, lon: number, h: number): number[][] {
	return [
		[lon - h, lat - h],
		[lon + h, lat - h],
		[lon + h, lat + h],
		[lon - h, lat + h],
		[lon - h, lat - h]
	];
}

function boundaryLine(
	name: string,
	adminLevel: number,
	coordinates: number[][][] | number[][][][],
	type: 'Polygon' | 'MultiPolygon' = 'Polygon'
): string {
	return (
		'' +
		JSON.stringify({
			type: 'Feature',
			geometry: { type, coordinates },
			properties: { boundary: 'administrative', admin_level: String(adminLevel), name }
		})
	);
}

// --- parseAdminBoundary ------------------------------------------------------

test('parseAdminBoundary parses a named administrative polygon at a used level', () => {
	const b = parseAdminBoundary(boundaryLine('Vancouver', 8, [squareRing(49.25, -123.1, 0.2)]));
	expect(b).not.toBeNull();
	if (!b) return;
	expect(b.name).toBe('Vancouver');
	expect(b.adminLevel).toBe(8);
	expect(b.rings.length).toBe(1);
});

test('parseAdminBoundary rejects other levels, unnamed and non-administrative features', () => {
	// Level 2 (country) and 10 (neighbourhood) are outside the used tiers.
	expect(parseAdminBoundary(boundaryLine('Canada', 2, [squareRing(60, -100, 30)]))).toBeNull();
	expect(parseAdminBoundary(boundaryLine('Downtown', 10, [squareRing(49, -123, 0.01)]))).toBeNull();
	// Not administrative.
	const park =
		'' +
		JSON.stringify({
			type: 'Feature',
			geometry: { type: 'Polygon', coordinates: [squareRing(49, -123, 0.01)] },
			properties: { boundary: 'national_park', name: 'administrative park' }
		});
	expect(parseAdminBoundary(park)).toBeNull();
	// Unnamed.
	const unnamed =
		'' +
		JSON.stringify({
			type: 'Feature',
			geometry: { type: 'Polygon', coordinates: [squareRing(49, -123, 0.01)] },
			properties: { boundary: 'administrative', admin_level: '8' }
		});
	expect(parseAdminBoundary(unnamed)).toBeNull();
	// Garbage never throws.
	expect(parseAdminBoundary('not json Polygon administrative')).toBeNull();
	expect(parseAdminBoundary('')).toBeNull();
});

test('parseAdminBoundary flattens MultiPolygon parts into one ring list', () => {
	const b = parseAdminBoundary(
		boundaryLine(
			'Two Isles',
			8,
			[[squareRing(49, -123, 0.1)], [squareRing(50, -124, 0.1)]],
			'MultiPolygon'
		)
	);
	expect(b?.rings.length).toBe(2);
});

// --- IndexedRings --------------------------------------------------------------

test('IndexedRings containment matches the ring, including holes', () => {
	// Outer square with a hole in the middle (even-odd parity across both rings).
	const outer = squareRing(49, -123, 1);
	const hole = squareRing(49, -123, 0.2);
	const indexed = new IndexedRings([outer, hole]);
	expect(indexed.contains(49.5, -123)).toBe(true); // inside outer, outside hole
	expect(indexed.contains(49, -123)).toBe(false); // inside the hole
	expect(indexed.contains(51, -123)).toBe(false); // outside entirely
	expect(indexed.contains(49.5, -120)).toBe(false); // outside bbox east
});

test('IndexedRings handles points far from any edge latitude band', () => {
	const indexed = new IndexedRings([squareRing(49, -123, 0.001)]);
	expect(indexed.contains(49.0005, -123)).toBe(true);
	expect(indexed.contains(89, -123)).toBe(false);
});

// --- AdminEnricher -------------------------------------------------------------

test('assigns city from the most specific containing boundary and region from level 4', () => {
	const rows = [
		poi({ osm_id: 'n1', latitude: 49.25, longitude: -123.1 }), // in Vancouver + Metro Van + BC
		poi({ osm_id: 'n2', latitude: 49.9, longitude: -122.0 }), // in Metro Van only + BC (rural)
		poi({ osm_id: 'n3', latitude: 53.5, longitude: -113.5 }) // outside every boundary here
	];
	const enricher = new AdminEnricher(rows);
	// Applied in a deliberately unhelpful order: the coarse regional district first.
	enricher.apply({
		name: 'Metro Vancouver Regional District',
		adminLevel: 6,
		rings: [squareRing(49.5, -122.8, 1)]
	});
	enricher.apply({ name: 'Vancouver', adminLevel: 8, rings: [squareRing(49.25, -123.1, 0.15)] });
	enricher.apply({ name: 'British Columbia', adminLevel: 4, rings: [squareRing(51, -123, 5)] });
	const { cities, regions } = enricher.finalize();

	expect(cities).toBe(2);
	expect(regions).toBe(2);
	expect(rows[0].admin_city).toBe('Vancouver'); // level 8 beats the containing level 6
	expect(rows[0].admin_region).toBe('BC'); // normalized to the 2-letter code
	expect(rows[1].admin_city).toBe('Metro Vancouver Regional District');
	expect(rows[1].admin_region).toBe('BC');
	expect(rows[2].admin_city).toBeNull();
	expect(rows[2].admin_region).toBeNull();
});

test('same-level overlap resolves to the smaller boundary; unknown region names kept raw', () => {
	const rows = [poi({ osm_id: 'n1', latitude: 10.0, longitude: 10.0 })];
	const enricher = new AdminEnricher(rows);
	enricher.apply({ name: 'Big Town', adminLevel: 8, rings: [squareRing(10, 10, 1)] });
	enricher.apply({ name: 'Small Town', adminLevel: 8, rings: [squareRing(10, 10, 0.1)] });
	enricher.apply({ name: 'Somewhere Province', adminLevel: 4, rings: [squareRing(10, 10, 5)] });
	enricher.finalize();
	expect(rows[0].admin_city).toBe('Small Town');
	// Not a CA/US region — the raw OSM name is kept rather than dropped.
	expect(rows[0].admin_region).toBe('Somewhere Province');
});
