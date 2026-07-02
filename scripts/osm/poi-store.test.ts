import { test, expect } from 'bun:test';
import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';

function row(over: Partial<PoiRow> & Pick<PoiRow, 'osm_id' | 'latitude' | 'longitude'>): PoiRow {
	return {
		osm_type: 'node',
		numeric_id: Number(over.osm_id.slice(1)) || 1,
		name: null,
		osm_class: 'restaurant',
		suggested_category: 'restaurant',
		cuisine: null,
		address: null,
		phone: null,
		website: null,
		opening_hours: null,
		diet_markers: [],
		admin_city: null,
		admin_region: null,
		tags_json: '{}',
		...over
	};
}

function freshStore(): OsmPoiStore {
	return OsmPoiStore.open(':memory:');
}

test('insertMany + count + searchBbox round-trips and filters by box', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({ osm_id: 'n1', latitude: 49.28, longitude: -123.12, name: 'In Box' }),
		row({ osm_id: 'n2', latitude: 51.0, longitude: -114.0, name: 'Far Away' })
	]);
	expect(store.count()).toBe(2);
	expect(store.count('test')).toBe(2);

	const hits = store.searchBbox({ minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 });
	expect(hits.map((h) => h.osm_id)).toEqual(['n1']);
	store.close();
});

test('searchBbox applies category, name and cuisine filters', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({
			osm_id: 'n1',
			latitude: 49.28,
			longitude: -123.12,
			name: 'Pho Real',
			suggested_category: 'restaurant',
			cuisine: 'vietnamese'
		}),
		row({
			osm_id: 'n2',
			latitude: 49.28,
			longitude: -123.12,
			name: 'Bean Cafe',
			suggested_category: 'cafe',
			cuisine: 'coffee_shop'
		})
	]);
	const box = { minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 };

	expect(store.searchBbox(box, { category: 'cafe' }).map((h) => h.osm_id)).toEqual(['n2']);
	// name match is case-insensitive substring
	expect(store.searchBbox(box, { name: 'pho' }).map((h) => h.osm_id)).toEqual(['n1']);
	expect(store.searchBbox(box, { cuisine: 'viet' }).map((h) => h.osm_id)).toEqual(['n1']);
	store.close();
});

test('searchBbox treats LIKE wildcards in the name literally', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({ osm_id: 'n1', latitude: 49.28, longitude: -123.12, name: 'Bar None' }),
		row({ osm_id: 'n2', latitude: 49.28, longitude: -123.12, name: 'A100% Place' })
	]);
	const box = { minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 };
	// '%' must match a literal percent, not "anything".
	expect(store.searchBbox(box, { name: '100%' }).map((h) => h.osm_id)).toEqual(['n2']);
	store.close();
});

test('cap limits rows returned', () => {
	const store = freshStore();
	store.insertMany(
		'test',
		Array.from({ length: 10 }, (_, i) =>
			row({ osm_id: `n${i}`, latitude: 49.28, longitude: -123.12 })
		)
	);
	const box = { minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 };
	expect(store.searchBbox(box, { cap: 3 }).length).toBe(3);
	store.close();
});

test('deleteRegion + insertMany swaps a region without touching others', () => {
	const store = freshStore();
	store.insertMany('canada', [row({ osm_id: 'n1', latitude: 49.28, longitude: -123.12 })]);
	store.insertMany('us', [row({ osm_id: 'n2', latitude: 40.0, longitude: -74.0 })]);

	// The extract pipeline (scripts/osm-extract.ts) replaces a region by clearing
	// it, then batch-inserting the fresh rows.
	store.deleteRegion('canada');
	store.insertMany('canada', [
		row({ osm_id: 'n3', latitude: 45.5, longitude: -73.5 }),
		row({ osm_id: 'n4', latitude: 43.6, longitude: -79.4 })
	]);
	expect(store.count('canada')).toBe(2);
	expect(store.count('us')).toBe(1);
	expect(store.regions()).toEqual(['canada', 'us']);
	store.close();
});

test('diet_markers survive the JSON round-trip', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({ osm_id: 'n1', latitude: 49.28, longitude: -123.12, diet_markers: ['vegan', 'halal'] })
	]);
	const [hit] = store.searchBbox({ minLat: 49, maxLat: 50, minLon: -124, maxLon: -123 });
	expect(hit.diet_markers).toEqual(['vegan', 'halal']);
	store.close();
});

test('getByOsmId returns a single POI verbatim (for the create_locations import path), or null', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({
			osm_id: 'n1',
			latitude: 49.2812,
			longitude: -123.1201,
			name: 'Corner Cafe',
			tags_json: '{"addr:housenumber":"1","addr:street":"Main St"}'
		})
	]);
	const hit = store.getByOsmId('n1');
	expect(hit?.name).toBe('Corner Cafe');
	// Coordinates come back exactly as stored — this is what keeps the import coordinate-exact.
	expect(hit?.latitude).toBe(49.2812);
	expect(hit?.longitude).toBe(-123.1201);
	expect(hit?.tags_json).toBe('{"addr:housenumber":"1","addr:street":"Main St"}');
	expect(store.getByOsmId('does-not-exist')).toBeNull();
	store.close();
});

test('openReadonly throws a helpful error when the file is missing', () => {
	expect(() => OsmPoiStore.openReadonly('/tmp/does-not-exist-osm-poi.sqlite')).toThrow(
		/osm:extract/
	);
});

test('searchBbox filters by brand:wikidata from tags_json', () => {
	const store = OsmPoiStore.open(':memory:');
	store.insertMany('test', [
		row({
			osm_id: 'n1',
			latitude: 49.1,
			longitude: -123.1,
			tags_json: JSON.stringify({ 'brand:wikidata': 'Q37158' })
		}),
		row({
			osm_id: 'n2',
			latitude: 49.2,
			longitude: -123.2,
			tags_json: JSON.stringify({ 'brand:wikidata': 'Q175106' })
		}),
		row({ osm_id: 'n3', latitude: 49.3, longitude: -123.3 })
	]);
	const bbox = { minLat: 48, minLon: -124, maxLat: 50, maxLon: -122 };
	const hits = store.searchBbox(bbox, { brand_wikidata: 'Q37158' });
	expect(hits.map((p) => p.osm_id)).toEqual(['n1']);
	// Composes with other filters (AND semantics).
	expect(store.searchBbox(bbox, { brand_wikidata: 'Q175106', name: 'nope' }).length).toBe(0);
});
