import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
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

	const hits = store.searchBbox({ minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 });
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
	const box = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 };

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
	const box = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 };
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
	const box = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 };
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
	const [hit] = store.searchBbox({ minLat: 49, maxLat: 50, minLng: -124, maxLng: -123 });
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

test('searchBbox filters by normalized_name with exact equality', () => {
	const store = freshStore();
	store.insertMany('test', [
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' }),
		row({ osm_id: 'n2', latitude: 49.2, longitude: -123.2, name: 'A and W' }),
		row({ osm_id: 'n3', latitude: 49.3, longitude: -123.3, name: 'A and W Restaurant' }),
		row({ osm_id: 'n4', latitude: 49.4, longitude: -123.4, name: null })
	]);
	const bbox = { minLat: 48, minLng: -124, maxLat: 50, maxLng: -122 };
	// Both "&" and "and" spellings share the pre-normalized value; superstrings
	// and nameless rows do not.
	const hits = store.searchBbox(bbox, { normalized_name: 'aandw' });
	expect(hits.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2']);
	store.close();
});

test('openReadonly self-heals a store built before normalized_name existed', () => {
	const path = join(tmpdir(), `poi-store-legacy-${process.pid}-${Math.random()}.sqlite`);
	// A legacy store: pre-normalized_name schema, one row inserted raw.
	const legacy = new Database(path, { create: true });
	legacy.run(`CREATE TABLE osm_poi (
		osm_id TEXT PRIMARY KEY, osm_type TEXT NOT NULL, numeric_id INTEGER NOT NULL,
		name TEXT, osm_class TEXT NOT NULL, suggested_category TEXT, cuisine TEXT,
		latitude REAL NOT NULL, longitude REAL NOT NULL, address TEXT, phone TEXT,
		website TEXT, opening_hours TEXT, diet_markers TEXT NOT NULL DEFAULT '[]',
		tags_json TEXT NOT NULL DEFAULT '{}', address_source TEXT, admin_city TEXT,
		admin_region TEXT, region TEXT NOT NULL
	)`);
	legacy.run(
		`INSERT INTO osm_poi (osm_id, osm_type, numeric_id, name, osm_class, latitude, longitude, region)
		 VALUES ('n1', 'node', 1, 'A and W', 'fast_food', 49.1, -123.1, 'test')`
	);
	legacy.close();
	try {
		const store = OsmPoiStore.openReadonly(path);
		const bbox = { minLat: 48, minLng: -124, maxLat: 50, maxLng: -122 };
		// The one-time migration backfilled the column, so the equality scan works.
		expect(store.searchBbox(bbox, { normalized_name: 'aandw' }).map((p) => p.osm_id)).toEqual([
			'n1'
		]);
		store.close();
	} finally {
		for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
	}
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
	const bbox = { minLat: 48, minLng: -124, maxLat: 50, maxLng: -122 };
	const hits = store.searchBbox(bbox, { brand_wikidata: 'Q37158' });
	expect(hits.map((p) => p.osm_id)).toEqual(['n1']);
	// Composes with other filters (AND semantics).
	expect(store.searchBbox(bbox, { brand_wikidata: 'Q175106', name: 'nope' }).length).toBe(0);
});
