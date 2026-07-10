import { test, expect } from 'bun:test';
import { findCoordinateDrift } from './find-coordinate-drift';
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

// Three DB locations: one perfectly aligned, one drifted, one with no OSM match.
function fixture() {
	const store = storeWith([
		row({ osm_id: 'n10', latitude: 49.28, longitude: -123.12, name: 'Joe Coffee' }), // == loc A
		row({ osm_id: 'n20', latitude: 49.2845, longitude: -123.12, name: 'Burger Town' }) // ~45 m from loc B
	]);
	const db = fakeD1([
		{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 }, // aligned (0 m)
		{ id: 'B', name: 'Burger Town', latitude: 49.2849, longitude: -123.12 }, // drifted ~45 m
		{ id: 'C', name: 'Ghost Kitchen', latitude: 49.29, longitude: -123.12 } // no OSM match
	]);
	return { store, db };
}

test('flags drifted locations with a snap-to OSM target and ignores aligned ones', async () => {
	const { store, db } = fixture();
	const res = await findCoordinateDrift(store, db, {});
	expect(res.scanned).toBe(3);
	expect(res.counts).toEqual({ drifted: 1, no_osm_match: 1 });
	expect(res.total_mismatches).toBe(2);
	expect(res.mismatches.map((m) => m.id)).toEqual(['B', 'C']); // drifted first, then unmatched

	const drifted = res.mismatches[0];
	expect(drifted.classification).toBe('drifted');
	expect(drifted.osm_url).toBe('https://www.openstreetmap.org/node/20');
	expect(drifted.osm_latitude).toBe(49.2845);
	expect(drifted.matched_osm_name).toBe('Burger Town');
	expect(drifted.distance_m).toBeGreaterThan(0);

	expect(res.mismatches[1].classification).toBe('no_osm_match');
	expect(res.mismatches[1].osm_url).toBeUndefined();
	store.close();
});

test('limit caps the returned set and additional reports the remainder', async () => {
	const { store, db } = fixture();
	const res = await findCoordinateDrift(store, db, { limit: 1 });
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(1);
	expect(res.mismatches.map((m) => m.id)).toEqual(['B']); // worst drift first
	store.close();
});

test('include_unmatched=false drops no_osm_match locations from the result', async () => {
	const { store, db } = fixture();
	const res = await findCoordinateDrift(store, db, { include_unmatched: false });
	expect(res.total_mismatches).toBe(1);
	expect(res.mismatches.map((m) => m.id)).toEqual(['B']);
	expect(res.counts.no_osm_match).toBe(1); // still reported in the breakdown
	store.close();
});

test('closed (soft-deleted) locations are excluded from the scan', async () => {
	const { store } = fixture();
	const db = fakeD1([
		{ id: 'A', name: 'Joe Coffee', latitude: 49.28, longitude: -123.12 },
		// Closed tombstone with no staging POI — must not surface as no_osm_match.
		{
			id: 'Z',
			name: 'Departed Diner',
			latitude: 49.3,
			longitude: -123.12,
			closed_at: '2026-01-01T00:00:00Z'
		}
	]);
	const res = await findCoordinateDrift(store, db, {});
	expect(res.scanned).toBe(1);
	expect(res.counts).toEqual({ drifted: 0, no_osm_match: 0 });
	store.close();
});

test('a tolerant radius treats a small drift as aligned', async () => {
	const { store, db } = fixture();
	const res = await findCoordinateDrift(store, db, { tolerance_m: 100, include_unmatched: false });
	expect(res.total_mismatches).toBe(0); // the ~45 m drift is now within tolerance
	store.close();
});

test('a finding dismissed via its emitted dismiss_key suppresses until the evidence changes', async () => {
	const { splitDismissKey } = await import('./audit-dismiss');
	// A drifted venue (name-matching node 60 m away) and an unmatched one.
	const store = storeWith([
		row({ osm_id: 'n80', latitude: 49.2805, longitude: -123.12, name: 'Drift Cafe' })
	]);
	const db = fakeD1([
		{ id: 'D', name: 'Drift Cafe', latitude: 49.28, longitude: -123.12 },
		{ id: 'U', name: 'Unmapped Diner', latitude: 49.5, longitude: -123.5 }
	]);

	const first = await findCoordinateDrift(store, db, {});
	expect(first.mismatches.length).toBe(2);
	const drifted = first.mismatches.find((m) => m.classification === 'drifted')!;
	// The fingerprint pins BOTH the matched node and our stored coordinate.
	expect(drifted.dismiss_key).toBe('D#drifted:https://www.openstreetmap.org/node/80:49.28,-123.12');
	const unmatched = first.mismatches.find((m) => m.classification === 'no_osm_match')!;
	expect(unmatched.dismiss_key).toBe('U#no_osm_match');

	const record = { reason: 'verified', dismissed_at: '2026-07-09' };
	const dismissals = new Map(
		[drifted, unmatched].map((m) => {
			const { subject, fingerprint } = splitDismissKey(m.dismiss_key)!;
			return [subject, { fingerprint, ...record }] as const;
		})
	);
	const suppressed = await findCoordinateDrift(store, db, { dismissals });
	expect(suppressed.mismatches.length).toBe(0);
	expect(suppressed.suppressed_dismissed).toBe(2);

	// A later coordinate edit on the drifted venue is NEW evidence — re-flags.
	const moved = fakeD1([
		{ id: 'D', name: 'Drift Cafe', latitude: 49.281, longitude: -123.12 },
		{ id: 'U', name: 'Unmapped Diner', latitude: 49.5, longitude: -123.5 }
	]);
	const reflagged = await findCoordinateDrift(store, moved, { dismissals });
	expect(reflagged.mismatches.map((m) => m.id)).toEqual(['D']);
	expect(reflagged.suppressed_dismissed).toBe(1); // only U still matches
	store.close();
});
