import { test, expect } from 'bun:test';
import { findIdentityDrift } from './find-identity-drift';
import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';
import type { D1Like, D1PreparedLike } from '../../src/lib/server/db';

interface Loc {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	closed_at?: string | null;
}

/** Minimal D1Like that returns the location list for the (param-less) scan query, honouring a `closed_at IS NULL` filter. */
function fakeD1(locations: Loc[]): D1Like {
	return {
		prepare(sql: string): D1PreparedLike {
			const rows = sql.includes('closed_at IS NULL')
				? locations.filter((l) => !l.closed_at)
				: locations;
			const stmt: D1PreparedLike = {
				bind() {
					return stmt;
				},
				async first<T>() {
					const { results } = await stmt.all<T>();
					return results[0] ?? null;
				},
				async all<T>() {
					return { results: rows as T[] };
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

function storeWith(rows: PoiRow[]): OsmPoiStore {
	const store = OsmPoiStore.open(':memory:');
	store.insertMany('test', rows);
	return store;
}

// Three DB locations: one whose node still matches, one whose node was renamed
// to a new occupant (with the venue's new node ~500 m away — the Veerji case),
// and one whose node is gone entirely.
function fixture() {
	const store = storeWith([
		row({
			osm_id: 'n10',
			latitude: 49.28,
			longitude: -123.12,
			name: 'Joe Coffee'
		}), // == loc A
		row({
			osm_id: 'n20',
			latitude: 49.2,
			longitude: -123.0,
			name: 'Delight Street Eats'
		}), // == loc B's coords, renamed
		row({
			osm_id: 'n21',
			latitude: 49.2045,
			longitude: -123.0,
			name: 'Veerji Grill'
		}) // B's venue, moved ~500 m
	]);
	const db = fakeD1([
		{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 }, // healthy
		{ id: 'B', name: 'Veerji Grill', latitude: 49.2, longitude: -123.0 }, // renamed under it
		{ id: 'C', name: 'Ghost Kitchen', latitude: 49.29, longitude: -123.12 } // node gone
	]);
	return { store, db };
}

test('flags renamed and vanished locations, leaving matching ones alone', async () => {
	const { store, db } = fixture();
	const res = await findIdentityDrift(store, db, { search_radius_m: 1000 });
	expect(res.scanned).toBe(3);
	expect(res.counts).toEqual({ renamed: 1, vanished: 1 });
	expect(res.flagged.map((f) => f.id)).toEqual(['B', 'C']); // renamed first, then vanished

	const renamed = res.flagged[0];
	expect(renamed.classification).toBe('renamed');
	expect(renamed.current_osm_name).toBe('Delight Street Eats');
	expect(renamed.osm_url).toBe('https://www.openstreetmap.org/node/20');
	expect(renamed.osm_distance_m).toBe(0);
	// The venue's new node nearby surfaces as a relocation lead.
	expect(renamed.relocation_lead?.osm_url).toBe('https://www.openstreetmap.org/node/21');
	expect(renamed.relocation_lead?.distance_m).toBeGreaterThan(100);

	const vanished = res.flagged[1];
	expect(vanished.classification).toBe('vanished');
	expect(vanished.osm_url).toBeUndefined();
	expect(vanished.relocation_lead).toBeUndefined();
	store.close();
});

test('a name-containment rename (venue kept its identity) is NOT flagged', async () => {
	// OSM mappers expanded the name; containment matching (search_poi's dedup
	// rule) recognises it as the same venue.
	const store = storeWith([
		row({
			osm_id: 'n30',
			latitude: 49.28,
			longitude: -123.12,
			name: 'Joe Coffee Roasters'
		})
	]);
	const db = fakeD1([{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 }]);
	const res = await findIdentityDrift(store, db, {});
	expect(res.total_flagged).toBe(0);
	store.close();
});

test('a nameless POI at the coordinates is a rename signal with current_osm_name null', async () => {
	const store = storeWith([row({ osm_id: 'n40', latitude: 49.28, longitude: -123.12 })]);
	const db = fakeD1([{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 }]);
	const res = await findIdentityDrift(store, db, {});
	expect(res.counts).toEqual({ renamed: 1, vanished: 0 });
	expect(res.flagged[0].current_osm_name).toBeNull();
	store.close();
});

test('limit caps the returned set and additional reports the remainder', async () => {
	const { store, db } = fixture();
	const res = await findIdentityDrift(store, db, {
		limit: 1,
		search_radius_m: 1000
	});
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(1);
	expect(res.flagged.map((f) => f.id)).toEqual(['B']); // renamed leads
	store.close();
});

test('include_vanished=false drops vanished locations but keeps the breakdown', async () => {
	const { store, db } = fixture();
	const res = await findIdentityDrift(store, db, {
		include_vanished: false,
		search_radius_m: 1000
	});
	expect(res.total_flagged).toBe(1);
	expect(res.flagged.map((f) => f.id)).toEqual(['B']);
	expect(res.counts.vanished).toBe(1); // still reported in the breakdown
	store.close();
});

test('closed (soft-deleted) locations are excluded from the scan', async () => {
	const { store } = fixture();
	const db = fakeD1([
		{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 },
		// Closed tombstone with no staging POI — must not surface as vanished.
		{
			id: 'Z',
			name: 'Departed Diner',
			latitude: 49.3,
			longitude: -123.12,
			closed_at: '2026-01-01T00:00:00Z'
		}
	]);
	const res = await findIdentityDrift(store, db, {});
	expect(res.scanned).toBe(1);
	expect(res.counts).toEqual({ renamed: 0, vanished: 0 });
	store.close();
});

test('a wider tolerance treats a near-coincident matching POI as healthy', async () => {
	// POI sits ~11 m away (rounding/remap jitter) but carries the venue's name.
	const store = storeWith([
		row({
			osm_id: 'n50',
			latitude: 49.2801,
			longitude: -123.12,
			name: 'Joe Coffee'
		})
	]);
	const db = fakeD1([{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 }]);
	const strict = await findIdentityDrift(store, db, {});
	expect(strict.counts.vanished).toBe(1); // 1 m default: nothing AT the point
	const tolerant = await findIdentityDrift(store, db, { tolerance_m: 20 });
	expect(tolerant.total_flagged).toBe(0);
	store.close();
});
