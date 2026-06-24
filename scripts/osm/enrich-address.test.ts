import { test, expect } from 'bun:test';
import { parseAddressedBuilding, AddressEnricher } from './enrich-address';
import type { PoiRow } from './map-feature';

/** Minimal PoiRow factory — only the fields enrichment reads/writes matter here. */
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
		...over
	};
}

/** A square polygon (as a Polygon coordinate list) centred on (lat, lon) with half-size `h` deg. */
function square(lat: number, lon: number, h: number): number[][][] {
	return [
		[
			[lon - h, lat - h],
			[lon + h, lat - h],
			[lon + h, lat + h],
			[lon - h, lat + h],
			[lon - h, lat - h]
		]
	];
}

const RS = '\u001e'; // RFC 8142 record separator that geojsonseq prefixes each line with

test('parseAddressedBuilding parses an RS-prefixed addressed polygon', () => {
	const line =
		RS +
		JSON.stringify({
			type: 'Feature',
			id: 'a123',
			geometry: { type: 'Polygon', coordinates: square(49.281, -123.121, 0.001) },
			properties: { 'addr:housenumber': '12', 'addr:street': 'Main St', 'addr:city': 'Vancouver' }
		});
	const b = parseAddressedBuilding(line);
	expect(b).not.toBeNull();
	if (!b) return; // narrows the type so the assertions below need no non-null `!`
	expect(b.osmId).toBe('a123');
	expect(b.address).toBe('12 Main St, Vancouver');
	expect(b.polygons.length).toBe(1);
});

test('parseAddressedBuilding rejects non-polygons and unaddressed polygons', () => {
	const point = JSON.stringify({
		type: 'Feature',
		geometry: { type: 'Point', coordinates: [-123, 49] },
		properties: { 'addr:housenumber': '5' }
	});
	expect(parseAddressedBuilding(point)).toBeNull(); // not a polygon (also fast-rejected)

	const noAddr = JSON.stringify({
		type: 'Feature',
		geometry: { type: 'Polygon', coordinates: square(49, -123, 0.001) },
		properties: { building: 'yes' }
	});
	expect(parseAddressedBuilding(noAddr)).toBeNull(); // no addr:housenumber

	expect(parseAddressedBuilding('')).toBeNull();
	expect(parseAddressedBuilding('not json {')).toBeNull();
});

test('enriches an address-less venue inside an addressed building, leaving others untouched', () => {
	const inside = poi({ osm_id: 'n1', latitude: 49.281, longitude: -123.121 }); // in the building
	const outside = poi({ osm_id: 'n2', latitude: 49.35, longitude: -123.3 }); // in no building
	const ownAddr = poi({
		osm_id: 'n3',
		latitude: 49.281,
		longitude: -123.121,
		address: '99 Existing Rd'
	}); // same spot, but already addressed
	const rows = [inside, outside, ownAddr];

	const enr = new AddressEnricher(rows);
	enr.apply({
		osmId: 'a1',
		address: '12 Main St, Vancouver',
		polygons: [square(49.281, -123.121, 0.001)]
	});
	const n = enr.finalize();

	expect(n).toBe(1);
	expect(inside.address).toBe('12 Main St, Vancouver'); // enriched
	expect(outside.address).toBeNull(); // no containing building
	expect(ownAddr.address).toBe('99 Existing Rd'); // own address preserved, never overwritten
});

test('when nested buildings contain a venue, the smallest (most specific) address wins', () => {
	const venue = poi({ osm_id: 'n1', latitude: 49.281, longitude: -123.121 });
	const big = {
		osmId: 'a-big',
		address: '1 Plaza Way',
		polygons: [square(49.281, -123.121, 0.01)]
	};
	const small = {
		osmId: 'a-small',
		address: '12 Main St',
		polygons: [square(49.281, -123.121, 0.0005)]
	};

	// Apply in both orders; the smallest-area address must win regardless.
	for (const order of [
		[big, small],
		[small, big]
	]) {
		venue.address = null;
		const enr = new AddressEnricher([venue]);
		for (const b of order) enr.apply(b);
		enr.finalize();
		expect(venue.address).toBe('12 Main St');
	}
});
