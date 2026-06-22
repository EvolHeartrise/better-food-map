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

test('openReadonly throws a helpful error when the file is missing', () => {
	expect(() => OsmPoiStore.openReadonly('/tmp/does-not-exist-osm-poi.sqlite')).toThrow(
		/osm:extract/
	);
});
