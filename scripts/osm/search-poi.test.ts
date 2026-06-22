import { test, expect } from 'bun:test';
import { searchPoi, normalizeName } from './search-poi';
import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';
import type { D1Like, D1PreparedLike } from '../../src/lib/server/db';

interface ExistingLoc {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
}

/**
 * Minimal D1Like that answers only the search_poi "existing locations in bbox"
 * query, filtering an in-memory list by the four bound bbox params.
 */
function fakeD1(locations: ExistingLoc[]): D1Like {
	return {
		prepare(): D1PreparedLike {
			let params: unknown[] = [];
			const stmt: D1PreparedLike = {
				bind(...values: unknown[]) {
					params = values;
					return stmt;
				},
				async first<T>() {
					const { results } = await stmt.all<T>();
					return results[0] ?? null;
				},
				async all<T>() {
					const [minLat, maxLat, minLon, maxLon] = params as number[];
					const results = locations.filter(
						(l) =>
							l.latitude >= minLat &&
							l.latitude <= maxLat &&
							l.longitude >= minLon &&
							l.longitude <= maxLon
					);
					return { results: results as T[] };
				},
				async run() {
					return { meta: { changes: 0 } };
				}
			};
			return stmt;
		},
		async batch() {
			return [];
		}
	};
}

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

const CENTRE = { lat: 49.2827, lon: -123.1207 };

function storeWith(rows: PoiRow[]): OsmPoiStore {
	const store = OsmPoiStore.open(':memory:');
	store.insertMany('test', rows);
	return store;
}

test('normalizeName strips case, accents and punctuation', () => {
	expect(normalizeName('Café Crème!')).toBe('cafecreme');
	expect(normalizeName("Joe's Diner")).toBe('joesdiner');
	expect(normalizeName('A & W')).toBe('aandw');
	expect(normalizeName(null)).toBe('');
});

test('centre+radius returns nearest-first with distance, excludes far POIs', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.2837, longitude: -123.1207, name: 'Near' }), // ~111 m
		row({ osm_id: 'n2', latitude: 49.2827, longitude: -123.1207, name: 'Here' }), // ~0 m
		row({ osm_id: 'n3', latitude: 49.5, longitude: -123.5, name: 'Outside radius' })
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates.map((c) => c.osm_id)).toEqual(['n2', 'n1']); // nearest first
	expect(res.candidates[0].distance_m).toBe(0);
	expect(res.total_in_area).toBe(2); // n3 outside the 1 km circle
	store.close();
});

test('exclude_existing drops same-point and same-name-nearby POIs, keeps the rest', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.2827, longitude: -123.1207, name: 'Coincident' }), // same spot as existing 'a'
		row({ osm_id: 'n2', latitude: 49.283, longitude: -123.1207, name: 'Tim Hortons' }), // ~22 m from existing 'b', same name
		row({ osm_id: 'n3', latitude: 49.284, longitude: -123.1207, name: 'Brand New Spot' }) // far from both / different name
	]);
	const db = fakeD1([
		{ id: 'a', name: 'Anything Here', latitude: 49.2827, longitude: -123.1207 },
		{ id: 'b', name: 'Tim Hortons', latitude: 49.2832, longitude: -123.1207 }
	]);
	const res = await searchPoi(store, db, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1
	});
	expect(res.candidates.map((c) => c.osm_id)).toEqual(['n3']);
	expect(res.excluded_existing).toBe(2);
	store.close();
});

test('candidate carries osm_url and suggested_category', async () => {
	const store = storeWith([
		row({
			osm_id: 'w12',
			osm_type: 'way',
			numeric_id: 12,
			latitude: 49.2827,
			longitude: -123.1207,
			name: 'Bakehouse',
			osm_class: 'bakery',
			suggested_category: 'bakery'
		})
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates[0].osm_url).toBe('https://www.openstreetmap.org/way/12');
	expect(res.candidates[0].suggested_category).toBe('bakery');
	store.close();
});

test('bbox query path works and respects limit + truncated flag', async () => {
	const rows = Array.from({ length: 5 }, (_, i) =>
		row({ osm_id: `n${i}`, latitude: 49.28 + i * 0.0001, longitude: -123.12 })
	);
	const store = storeWith(rows);
	const res = await searchPoi(store, null, {
		bbox: { minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 },
		exclude_existing: false,
		limit: 2
	});
	expect(res.candidates.length).toBe(2);
	expect(res.truncated).toBe(true);
	// bbox query has no centre, so no distance is attached
	expect(res.candidates[0].distance_m).toBeUndefined();
	store.close();
});

async function messageOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return '';
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

test('throws when neither bbox nor centre+radius is given', async () => {
	const store = storeWith([]);
	expect(await messageOf(searchPoi(store, null, { exclude_existing: false }))).toMatch(
		/bbox.*or.*latitude/i
	);
	store.close();
});

test('exclude_existing default true requires a db handle', async () => {
	const store = storeWith([row({ osm_id: 'n1', latitude: 49.2827, longitude: -123.1207 })]);
	const msg = await messageOf(
		searchPoi(store, null, { latitude: CENTRE.lat, longitude: CENTRE.lon, radius_km: 1 })
	);
	expect(msg).toMatch(/exclude_existing requires/);
	store.close();
});
