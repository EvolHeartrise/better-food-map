import { test, expect } from 'bun:test';
import { parseFeatureLine } from './load-geojson';
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
