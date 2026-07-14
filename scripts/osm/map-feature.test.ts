import { test, expect } from 'bun:test';
import {
	addressPartsFromLine,
	classOf,
	composeAddress,
	dietMarkers,
	isClosed,
	mapFeature,
	osmAddressParts,
	osmUrl,
	parseOsmId,
	representativePoint,
	suggestedCategory,
	type OsmFeature,
	type PoiRow
} from './map-feature';

/** Narrows a mapFeature result to a non-null PoiRow (and fails the test if null). */
function assertPoi(row: PoiRow | null): asserts row is PoiRow {
	expect(row).not.toBeNull();
}

test('classOf recognises food amenities and shops, rejects others', () => {
	expect(classOf({ amenity: 'restaurant' })).toBe('restaurant');
	expect(classOf({ shop: 'bakery' })).toBe('bakery');
	expect(classOf({ amenity: 'bench' })).toBeNull();
	expect(classOf({ shop: 'clothes' })).toBeNull();
	expect(classOf({})).toBeNull();
	// amenity takes precedence over a (non-food) shop tag.
	expect(classOf({ amenity: 'cafe', shop: 'clothes' })).toBe('cafe');
});

test('suggestedCategory maps to the app enum, null where no clean fit', () => {
	expect(suggestedCategory('restaurant')).toBe('restaurant');
	expect(suggestedCategory('cafe')).toBe('cafe');
	expect(suggestedCategory('fast_food')).toBe('fast_food');
	expect(suggestedCategory('bakery')).toBe('bakery');
	expect(suggestedCategory('pastry')).toBe('bakery');
	expect(suggestedCategory('bar')).toBeNull();
	expect(suggestedCategory('pub')).toBeNull();
	expect(suggestedCategory('ice_cream')).toBeNull();
});

test('composeAddress joins present addr:* parts (region/postcode space-joined), null when none', () => {
	expect(
		composeAddress({
			'addr:housenumber': '123',
			'addr:street': 'Main St',
			'addr:city': 'Vancouver',
			'addr:province': 'BC',
			'addr:postcode': 'V6A 1A1'
		})
	).toBe('123 Main St, Vancouver, BC V6A 1A1');
	expect(composeAddress({ 'addr:city': 'Vancouver' })).toBe('Vancouver');
	expect(composeAddress({})).toBeNull();
});

test('addressPartsFromLine inverts composeAddressLine (region/postcode space-joined)', () => {
	// Round-trips the canonical form composeAddress emits.
	expect(addressPartsFromLine('123 Main St, Vancouver, BC V6A 1A1')).toEqual({
		street: '123 Main St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6A 1A1'
	});
	// Multi-word region full name, US ZIP.
	expect(addressPartsFromLine('30 Farnham Gate Road, Halifax, Nova Scotia, B3M 3W8')).toEqual({
		street: '30 Farnham Gate Road',
		city: 'Halifax',
		region: 'Nova Scotia',
		postcode: 'B3M 3W8'
	});
	expect(addressPartsFromLine('500 Oak Ave, Seattle, WA 98101')).toEqual({
		street: '500 Oak Ave',
		city: 'Seattle',
		region: 'WA',
		postcode: '98101'
	});
});

test('addressPartsFromLine validates the tail and degrades gracefully', () => {
	// A non-region trailing segment is kept as city, never mislabelled region.
	expect(addressPartsFromLine('123 Main St, Vancouver')).toEqual({
		street: '123 Main St',
		city: 'Vancouver'
	});
	// Region with no postcode.
	expect(addressPartsFromLine('123 Main St, Vancouver, BC')).toEqual({
		street: '123 Main St',
		city: 'Vancouver',
		region: 'BC'
	});
	// A lone segment becomes the (required) street.
	expect(addressPartsFromLine('12 Main St')).toEqual({ street: '12 Main St' });
	expect(addressPartsFromLine(null)).toBeUndefined();
	expect(addressPartsFromLine('')).toBeUndefined();
	expect(addressPartsFromLine('   ')).toBeUndefined();
});

test('composeAddress includes addr:unit in the street (Canadian hyphen style)', () => {
	expect(
		composeAddress({
			'addr:unit': '100',
			'addr:housenumber': '6485',
			'addr:street': '120 St',
			'addr:city': 'Surrey',
			'addr:province': 'BC'
		})
	).toBe('100-6485 120 St, Surrey, BC');
});

test('osmAddressParts extracts raw addr:* parts (street via composeStreet)', () => {
	expect(
		osmAddressParts({
			'addr:unit': '100',
			'addr:housenumber': '6485',
			'addr:street': '120 St',
			'addr:city': 'Surrey',
			'addr:state': 'British Columbia',
			'addr:postcode': 'V3R 0N3',
			'addr:country': 'CA'
		})
	).toEqual({
		street: '100-6485 120 St',
		city: 'Surrey',
		region: 'British Columbia',
		postcode: 'V3R 0N3',
		country: 'CA'
	});
	expect(osmAddressParts({})).toEqual({
		street: null,
		city: null,
		region: null,
		postcode: null,
		country: null
	});
});

test('dietMarkers maps only explicit yes/only diet tags', () => {
	expect(dietMarkers({ 'diet:vegan': 'yes', 'diet:vegetarian': 'only' })).toEqual([
		'vegan',
		'vegetarian'
	]);
	expect(dietMarkers({ 'diet:vegan': 'no' })).toEqual([]);
	expect(dietMarkers({ 'diet:gluten_free': 'yes' })).toEqual(['gluten_friendly']);
	expect(dietMarkers({ 'diet:lactose_free': 'yes' })).toEqual(['dairy_free']);
	expect(dietMarkers({ cuisine: 'vegan' })).toEqual([]); // cuisine is not a diet marker
});

test('parseOsmId handles node/way/relation and area decoding', () => {
	expect(parseOsmId('n123')).toEqual({ osm_id: 'n123', osm_type: 'node', numeric_id: 123 });
	expect(parseOsmId('w456')).toEqual({ osm_id: 'w456', osm_type: 'way', numeric_id: 456 });
	expect(parseOsmId('r789')).toEqual({ osm_id: 'r789', osm_type: 'relation', numeric_id: 789 });
	// area id 246 = way 123 * 2 (even) -> way 123
	expect(parseOsmId('a246')).toEqual({ osm_id: 'w123', osm_type: 'way', numeric_id: 123 });
	// area id 247 = relation 123 * 2 + 1 (odd) -> relation 123
	expect(parseOsmId('a247')).toEqual({ osm_id: 'r123', osm_type: 'relation', numeric_id: 123 });
	// bare numeric -> node
	expect(parseOsmId('789')).toEqual({ osm_id: 'n789', osm_type: 'node', numeric_id: 789 });
	expect(parseOsmId('')).toBeNull();
	expect(parseOsmId(undefined)).toBeNull();
});

test('osmUrl builds canonical openstreetmap.org links', () => {
	expect(osmUrl('node', 123)).toBe('https://www.openstreetmap.org/node/123');
	expect(osmUrl('way', 456)).toBe('https://www.openstreetmap.org/way/456');
});

test('representativePoint returns the point, or a polygon centroid', () => {
	expect(representativePoint({ type: 'Point', coordinates: [-123.1, 49.2] })).toEqual([
		-123.1, 49.2
	]);
	const square = representativePoint({
		type: 'Polygon',
		coordinates: [
			[
				[0, 0],
				[2, 0],
				[2, 2],
				[0, 2],
				[0, 0]
			]
		]
	});
	expect(square).not.toBeNull();
	const [sx, sy] = square ?? [NaN, NaN];
	expect(sx).toBeCloseTo(0.8, 5); // mean of 0,2,2,0,0
	expect(sy).toBeCloseTo(0.8, 5);
	expect(representativePoint(null)).toBeNull();
});

test('mapFeature builds a row from a node restaurant feature', () => {
	const feature: OsmFeature = {
		type: 'Feature',
		properties: {
			'@id': 'n42',
			name: 'Cafe Test',
			amenity: 'restaurant',
			cuisine: 'italian',
			'addr:housenumber': '10',
			'addr:street': 'Broadway',
			'addr:city': 'Vancouver',
			phone: '+1 604 555 0100',
			website: 'https://example.com',
			opening_hours: 'Mo-Fr 09:00-17:00',
			'diet:vegetarian': 'yes'
		},
		geometry: { type: 'Point', coordinates: [-123.1, 49.26] }
	};
	const row = mapFeature(feature);
	assertPoi(row);
	expect(row.osm_id).toBe('n42');
	expect(row.osm_type).toBe('node');
	expect(row.name).toBe('Cafe Test');
	expect(row.osm_class).toBe('restaurant');
	expect(row.suggested_category).toBe('restaurant');
	expect(row.latitude).toBe(49.26);
	expect(row.longitude).toBe(-123.1);
	expect(row.address).toBe('10 Broadway, Vancouver');
	expect(row.diet_markers).toEqual(['vegetarian']);
});

test('mapFeature rejects non-food and geometry-less features', () => {
	expect(
		mapFeature({
			properties: { '@id': 'n1', amenity: 'bench' },
			geometry: { type: 'Point', coordinates: [0, 0] }
		})
	).toBeNull();
	expect(mapFeature({ properties: { '@id': 'n1', amenity: 'cafe' }, geometry: null })).toBeNull();
	expect(mapFeature({ properties: null })).toBeNull();
});

test('isClosed flags closure signals, passes live venues', () => {
	// opening_hours marking permanent/indefinite closure.
	expect(isClosed({ amenity: 'restaurant', opening_hours: 'closed' })).toBe(true);
	expect(isClosed({ amenity: 'restaurant', opening_hours: 'off' })).toBe(true);
	// lifecycle yes-flags left on a still-primary-tagged venue.
	expect(isClosed({ amenity: 'restaurant', disused: 'yes' })).toBe(true);
	expect(isClosed({ shop: 'bakery', abandoned: 'yes' })).toBe(true);
	// lifecycle-prefixed classification key alongside the live one.
	expect(isClosed({ amenity: 'restaurant', 'disused:amenity': 'restaurant' })).toBe(true);
	expect(isClosed({ shop: 'bakery', 'was:shop': 'bakery' })).toBe(true);
	// a live venue with normal hours is not closed.
	expect(isClosed({ amenity: 'restaurant', opening_hours: 'Mo-Fr 09:00-17:00' })).toBe(false);
	expect(isClosed({ amenity: 'cafe' })).toBe(false);
	// a lifecycle prefix on an UNRELATED feature must not flag the food POI.
	expect(isClosed({ amenity: 'restaurant', 'disused:railway': 'station' })).toBe(false);
});

test('mapFeature drops closed/disused venues even when the food tag is live', () => {
	const point = { type: 'Point', coordinates: [-123.1, 49.26] };
	expect(
		mapFeature({
			properties: { '@id': 'n1', amenity: 'restaurant', disused: 'yes' },
			geometry: point
		})
	).toBeNull();
	expect(
		mapFeature({
			properties: { '@id': 'n2', amenity: 'restaurant', opening_hours: 'closed' },
			geometry: point
		})
	).toBeNull();
	// sanity: the same feature without the closure signal is kept.
	assertPoi(
		mapFeature({
			properties: { '@id': 'n3', amenity: 'restaurant', name: 'Open Spot' },
			geometry: point
		})
	);
});

test('poiCountry resolves from explicit country, then region; null means no signal', async () => {
	const { poiCountry } = await import('./map-feature');
	const poi = (over: {
		tags_json?: string;
		address?: string | null;
		admin_region?: string | null;
	}) => ({
		tags_json: over.tags_json ?? '{}',
		address: over.address ?? null,
		admin_city: null,
		admin_region: over.admin_region ?? null
	});
	// Own addr:country wins outright.
	expect(
		poiCountry(poi({ tags_json: JSON.stringify({ 'addr:country': 'CA', 'addr:state': 'ME' }) }))
	).toBe('CA');
	// A US state code signals US even inside a Canada extract (the Fort Kent case).
	expect(poiCountry(poi({ tags_json: JSON.stringify({ 'addr:state': 'ME' }) }))).toBe('US');
	// A Canadian admin-join province signals CA; full names resolve too.
	expect(poiCountry(poi({ admin_region: 'BC' }))).toBe('CA');
	expect(poiCountry(poi({ tags_json: JSON.stringify({ 'addr:province': 'Ontario' }) }))).toBe('CA');
	// No address at all, or an unresolvable region → no signal.
	expect(poiCountry(poi({}))).toBeNull();
	expect(poiCountry(poi({ admin_region: 'ZZ' }))).toBeNull();
});
