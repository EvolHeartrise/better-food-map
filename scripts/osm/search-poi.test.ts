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
					const [minLat, maxLat, minLng, maxLng] = params as number[];
					const results = locations.filter(
						(l) =>
							l.latitude >= minLat &&
							l.latitude <= maxLat &&
							l.longitude >= minLng &&
							l.longitude <= maxLng
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
		admin_city: null,
		admin_region: null,
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
		row({ osm_id: 'n1', latitude: 49.2827, longitude: -123.1207, name: null }), // unnamed node on the same spot as existing 'a'
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

test('exclude_existing keeps a different-brand POI sharing a coordinate (food court)', async () => {
	const store = storeWith([
		// A Quiznos on essentially the same spot as an existing KFC — distinct brands
		// colocated in a food court, not a duplicate of each other.
		row({ osm_id: 'n1', latitude: 49.2827, longitude: -123.1207, name: 'Quiznos' }),
		// An unnamed node on that same spot stays a dup: no name to tell it apart.
		row({ osm_id: 'n2', latitude: 49.2827, longitude: -123.1207, name: null })
	]);
	const db = fakeD1([{ id: 'kfc', name: 'KFC', latitude: 49.2827, longitude: -123.1207 }]);
	const res = await searchPoi(store, db, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1
	});
	expect(res.candidates.map((c) => c.osm_id)).toEqual(['n1']);
	expect(res.excluded_existing).toBe(1);
	store.close();
});

test('exclude_existing surfaces an unnamed POI ~22 m away (SAME_POINT_M is tight)', async () => {
	const store = storeWith([
		// Unnamed node ~22 m from the existing location: beyond the tightened same-point
		// radius and with no name to match, so it is surfaced rather than absorbed.
		row({ osm_id: 'n1', latitude: 49.2829, longitude: -123.1207, name: null }),
		// Unnamed node on the exact spot is still treated as a duplicate.
		row({ osm_id: 'n2', latitude: 49.2827, longitude: -123.1207, name: null })
	]);
	const db = fakeD1([{ id: 'a', name: 'Existing Cafe', latitude: 49.2827, longitude: -123.1207 }]);
	const res = await searchPoi(store, db, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1
	});
	expect(res.candidates.map((c) => c.osm_id)).toEqual(['n1']);
	expect(res.excluded_existing).toBe(1);
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
		bbox: { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 },
		exclude_existing: false,
		limit: 2
	});
	expect(res.candidates.length).toBe(2);
	expect(res.truncated).toBe(true);
	// The 5-row store is nowhere near the scan cap.
	expect(res.scan_truncated).toBe(false);
	// bbox query has no centre, so no distance is attached
	expect(res.candidates[0].distance_m).toBeUndefined();
	store.close();
});

test('scan_truncated reports a saturated scan even when exclusions empty the results', async () => {
	const rows = Array.from({ length: 4 }, (_, i) =>
		row({ osm_id: `n${i}`, latitude: 49.28 + i * 0.0001, longitude: -123.12, name: `Spot ${i}` })
	);
	const store = storeWith(rows);
	const bbox = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.0 };

	// Cap of 3 < 4 rows in the box: the scan is truncated regardless of filters.
	const res = await searchPoi(store, null, {
		bbox,
		exclude_existing: false,
		scanCap: 3
	});
	expect(res.scan_truncated).toBe(true);
	expect(res.total_in_area).toBe(3); // pinned at the cap — a lower bound

	// The fill-the-map failure mode: everything scanned is excluded, yet the box
	// is NOT exhausted — scan_truncated must still say so while truncated is false.
	const excluded = await searchPoi(store, null, {
		bbox,
		exclude_existing: false,
		exclude_osm_ids: ['n0', 'n1', 'n2', 'n3'],
		scanCap: 3
	});
	expect(excluded.candidates.length).toBe(0);
	expect(excluded.truncated).toBe(false);
	expect(excluded.scan_truncated).toBe(true);

	// With the cap clear of the row count, the flag stays off.
	const clear = await searchPoi(store, null, { bbox, exclude_existing: false, scanCap: 10 });
	expect(clear.scan_truncated).toBe(false);
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

test('candidates expose structured address_parts from the POI addr:* tags', async () => {
	const tags = {
		amenity: 'cafe',
		name: 'Tagged Cafe',
		'addr:housenumber': '1909',
		'addr:street': 'W 4th Ave',
		'addr:city': 'Vancouver',
		'addr:state': 'BC',
		'addr:postcode': 'V6J 1M5',
		'addr:country': 'CA'
	};
	const store = storeWith([
		row({
			osm_id: 'n10',
			latitude: 49.2827,
			longitude: -123.1207,
			name: 'Tagged Cafe',
			tags_json: JSON.stringify(tags)
		})
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates[0].address_parts).toEqual({
		street: '1909 W 4th Ave',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA'
	});
	store.close();
});

test('address_parts is omitted when the POI carries no addr:* tags and no address', async () => {
	const store = storeWith([row({ osm_id: 'n11', latitude: 49.2827, longitude: -123.1207 })]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates[0].address_parts).toBeUndefined();
	store.close();
});

test('address_parts is recovered from an enrichment-supplied single-line address', async () => {
	// No own addr:* tags, but an enrichment feed (building containment / Overture)
	// filled the single-line `address` — its parts must survive in address_parts.
	const store = storeWith([
		row({
			osm_id: 'n12',
			latitude: 49.2827,
			longitude: -123.1207,
			name: 'Enriched Diner',
			address: '30 Farnham Gate Road, Halifax, Nova Scotia, B3M 3W8'
		})
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates[0].address_parts).toEqual({
		street: '30 Farnham Gate Road',
		city: 'Halifax',
		region: 'Nova Scotia',
		postcode: 'B3M 3W8'
	});
	store.close();
});

test('exclude_osm_ids drops candidates before the limit fills', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.2827, longitude: -123.1207, name: 'Keep' }),
		row({ osm_id: 'n2', latitude: 49.2828, longitude: -123.1207, name: 'Known false match' }),
		row({ osm_id: 'n3', latitude: 49.2829, longitude: -123.1207, name: 'Also keep' })
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false,
		exclude_osm_ids: ['n2'],
		limit: 2
	});
	// n2 is gone and does NOT count against the limit — both keepers fit.
	expect(res.candidates.map((c) => c.osm_id)).toEqual(['n1', 'n3']);
	store.close();
});

test('admin-boundary city/region fill address_parts when nothing else has them', async () => {
	const store = storeWith([
		row({
			osm_id: 'n1',
			latitude: 49.2827,
			longitude: -123.1207,
			name: 'Kiosk',
			address: '465 Merecroft Road', // street-only enrichment line
			admin_city: 'Campbell River',
			admin_region: 'BC'
		})
	]);
	const res = await searchPoi(store, null, {
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1,
		exclude_existing: false
	});
	expect(res.candidates[0].address_parts).toEqual({
		street: '465 Merecroft Road',
		city: 'Campbell River',
		region: 'BC'
	});
	store.close();
});

test('country scope drops foreign-signalled POIs, keeps unknowns, and counts the drops', async () => {
	const store = storeWith([
		// Own addr:state = ME (Maine) → US-signalled → dropped under country "CA".
		row({
			osm_id: 'us1',
			latitude: 47.25,
			longitude: -68.6,
			name: 'Subway',
			tags_json: JSON.stringify({
				'addr:housenumber': '100',
				'addr:street': 'West Main Street',
				'addr:state': 'ME'
			})
		}),
		// Admin-joined Canadian province → kept.
		row({
			osm_id: 'ca1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Subway',
			admin_city: 'Vancouver',
			admin_region: 'BC'
		}),
		// No country signal → kept (cannot be proven foreign).
		row({ osm_id: 'unk1', latitude: 49.2, longitude: -123.2, name: 'Subway' })
	]);
	const bbox = { minLat: 45, minLng: -125, maxLat: 51, maxLng: -60 };

	const scoped = await searchPoi(store, null, {
		bbox,
		country: 'CA',
		exclude_existing: false
	});
	expect(scoped.candidates.map((c) => c.osm_id).toSorted()).toEqual(['ca1', 'unk1']);
	expect(scoped.excluded_foreign).toBe(1);
	expect(scoped.total_in_area).toBe(2); // foreign POIs are out before totals

	// Without the scope the field is absent and nothing is dropped.
	const unscoped = await searchPoi(store, null, { bbox, exclude_existing: false });
	expect(unscoped.candidates.length).toBe(3);
	expect('excluded_foreign' in unscoped).toBe(false);
});
