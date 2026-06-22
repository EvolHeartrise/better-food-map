import { test, expect } from 'bun:test';
import { parseFeatureLine, loadLines } from './load-geojson';
import { OsmPoiStore } from './poi-store';
import type { OsmFeature } from './map-feature';

const RS = String.fromCharCode(0x1e); // RFC 8142 record separator

function featureLine(feature: OsmFeature, withSeparator = false): string {
	return (withSeparator ? RS : '') + JSON.stringify(feature);
}

const restaurant: OsmFeature = {
	type: 'Feature',
	properties: { '@id': 'n7', name: 'Test Diner', amenity: 'restaurant' },
	geometry: { type: 'Point', coordinates: [-123.1, 49.26] }
};

test('parseFeatureLine handles a record-separator-prefixed line', () => {
	const row = parseFeatureLine(featureLine(restaurant, true));
	expect(row).not.toBeNull();
	expect(row?.osm_id).toBe('n7');
	expect(row?.name).toBe('Test Diner');
});

test('parseFeatureLine returns null for blank, invalid, or non-food lines', () => {
	expect(parseFeatureLine('')).toBeNull();
	expect(parseFeatureLine('   ')).toBeNull();
	expect(parseFeatureLine(RS)).toBeNull();
	expect(parseFeatureLine('{not json')).toBeNull();
	expect(
		parseFeatureLine(
			featureLine({
				properties: { '@id': 'n1', amenity: 'bench' },
				geometry: { type: 'Point', coordinates: [0, 0] }
			})
		)
	).toBeNull();
});

test('loadLines inserts food POIs and counts skips', () => {
	const store = OsmPoiStore.open(':memory:');
	const lines = [
		featureLine(restaurant, true),
		'', // blank -> skipped silently (not counted)
		featureLine(
			{
				properties: { '@id': 'n8', amenity: 'bench' },
				geometry: { type: 'Point', coordinates: [0, 0] }
			},
			true
		), // not food -> skipped
		featureLine(
			{
				properties: { '@id': 'w9', name: 'Bakehouse', shop: 'bakery' },
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[-123.2, 49.2],
							[-123.1, 49.2],
							[-123.1, 49.3],
							[-123.2, 49.3],
							[-123.2, 49.2]
						]
					]
				}
			},
			true
		)
	];

	const { inserted, skipped } = loadLines(store, 'canada', lines);
	expect(inserted).toBe(2);
	expect(skipped).toBe(1); // only the non-food bench; the blank line is not a skip
	expect(store.count('canada')).toBe(2);
	store.close();
});

test('loadLines replaces a region on reload', () => {
	const store = OsmPoiStore.open(':memory:');
	loadLines(store, 'canada', [featureLine(restaurant, true)]);
	expect(store.count('canada')).toBe(1);
	// reload with a different single feature -> region replaced, not appended
	loadLines(store, 'canada', [
		featureLine(
			{
				properties: { '@id': 'n99', name: 'New Spot', amenity: 'cafe' },
				geometry: { type: 'Point', coordinates: [-123.0, 49.2] }
			},
			true
		)
	]);
	expect(store.count('canada')).toBe(1);
	const [hit] = store.searchBbox({ minLat: 49, maxLat: 50, minLon: -124, maxLon: -122 });
	expect(hit.osm_id).toBe('n99');
	store.close();
});
