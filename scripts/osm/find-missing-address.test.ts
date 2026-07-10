import { test, expect } from 'bun:test';
import { findMissingAddress, usableAddress } from './find-missing-address';
import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';
import type { D1Like, D1PreparedLike } from '../../src/lib/server/db';

interface Loc {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
	closed_at?: string | null;
}

/** All address parts null — a fully address-less location. */
const NO_ADDR = { street: null, city: null, region: null, postcode: null, country: null };

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

// Five DB locations covering every outcome:
//   A — all required parts present                       → skipped
//   B — no parts, OSM POI nearby WITH an address         → osm_fix_available (missing)
//   C — no parts, OSM POI nearby with NO address         → osm_has_no_address (missing)
//   D — no parts, no name-matching OSM POI               → no_osm_match (missing)
//   E — street only (missing city/region/country), POI WITH address → osm_fix_available (incomplete)
function fixture() {
	const store = storeWith([
		row({
			osm_id: 'n10',
			latitude: 49.281,
			longitude: -123.121,
			name: 'Joe Coffee',
			address: '12 Main St'
		}),
		row({
			osm_id: 'n20',
			latitude: 49.282,
			longitude: -123.122,
			name: 'Burger Town',
			address: null
		}),
		row({
			osm_id: 'n30',
			latitude: 49.283,
			longitude: -123.123,
			name: 'Pizza Plus',
			address: '99 King St'
		})
	]);
	const db = fakeD1([
		{
			id: 'A',
			name: 'Cafe Aligned',
			latitude: 49.28,
			longitude: -123.12,
			street: '1 Real Rd',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA'
		},
		{ id: 'B', name: 'Joe Coffee', latitude: 49.281, longitude: -123.121, ...NO_ADDR },
		{ id: 'C', name: 'Burger Town', latitude: 49.282, longitude: -123.122, ...NO_ADDR },
		{ id: 'D', name: 'Ghost Kitchen', latitude: 49.29, longitude: -123.12, ...NO_ADDR },
		{
			id: 'E',
			name: 'Pizza Plus',
			latitude: 49.283,
			longitude: -123.123,
			street: '31',
			city: null,
			region: null,
			postcode: null,
			country: null
		}
	]);
	return { store, db };
}

test('usableAddress keeps real addresses (trimmed) and rejects streetless fragments', () => {
	expect(usableAddress('12 Main St')).toBe('12 Main St');
	expect(usableAddress('  12 Main St  ')).toBe('12 Main St');
	expect(usableAddress('東京都港区1-2-3')).toBe('東京都港区1-2-3'); // letters in a non-Latin script
	expect(usableAddress('31')).toBeNull();
	expect(usableAddress('90210')).toBeNull();
	expect(usableAddress('')).toBeNull();
	expect(usableAddress('   ')).toBeNull();
	expect(usableAddress(null)).toBeNull();
});

test('osm_address_parts is surfaced from the matched POI’s own addr:* tags', async () => {
	const store = storeWith([
		row({
			osm_id: 'n40',
			latitude: 49.284,
			longitude: -123.124,
			name: 'Sushi Bar',
			address: '100-6485 120 St, Surrey, BC V3R 0N3',
			tags_json: JSON.stringify({
				'addr:unit': '100',
				'addr:housenumber': '6485',
				'addr:street': '120 St',
				'addr:city': 'Surrey',
				'addr:state': 'BC',
				'addr:postcode': 'V3R 0N3',
				'addr:country': 'CA'
			})
		})
	]);
	const db = fakeD1([
		{ id: 'S', name: 'Sushi Bar', latitude: 49.284, longitude: -123.124, ...NO_ADDR }
	]);
	const res = await findMissingAddress(store, db, {});
	const s = res.locations[0];
	expect(s.classification).toBe('osm_fix_available');
	expect(s.osm_address_parts).toEqual({
		street: '100-6485 120 St',
		city: 'Surrey',
		region: 'BC',
		postcode: 'V3R 0N3',
		country: 'CA'
	});
	store.close();
});

test('classifies missing/incomplete addresses by what OSM can supply', async () => {
	const { store, db } = fixture();
	const res = await findMissingAddress(store, db, {});
	expect(res.scanned).toBe(5);
	expect(res.total_missing).toBe(4); // A has a usable address and is skipped
	expect(res.counts).toEqual({
		osm_fix_available: 2,
		osm_has_no_address: 1,
		no_osm_match: 1,
		by_reason: { missing: 3, incomplete: 1 }
	});
	// Actionable first (both ~0 m, stable order), then OSM-can't-fix tails.
	expect(res.locations.map((l) => l.id)).toEqual(['B', 'E', 'C', 'D']);

	const b = res.locations[0];
	expect(b.classification).toBe('osm_fix_available');
	expect(b.reason).toBe('missing');
	expect(b.current_address).toBeNull();
	expect(b.osm_address).toBe('12 Main St');
	// No own addr:* tags, so parts are recovered from the single-line address instead.
	expect(b.osm_address_parts).toEqual({ street: '12 Main St' });
	expect(b.osm_url).toBe('https://www.openstreetmap.org/node/10');
	expect(b.matched_osm_name).toBe('Joe Coffee');

	const e = res.locations[1];
	expect(e.classification).toBe('osm_fix_available');
	expect(e.reason).toBe('incomplete');
	expect(e.current_address).toBe('31');
	expect(e.osm_address).toBe('99 King St');

	const c = res.locations[2];
	expect(c.classification).toBe('osm_has_no_address');
	expect(c.osm_url).toBe('https://www.openstreetmap.org/node/20'); // matched, but POI has no address
	expect(c.osm_address).toBeUndefined();

	const d = res.locations[3];
	expect(d.classification).toBe('no_osm_match');
	expect(d.osm_url).toBeUndefined();
	store.close();
});

test('include_incomplete=false ignores streetless fragments', async () => {
	const { store, db } = fixture();
	const res = await findMissingAddress(store, db, { include_incomplete: false });
	expect(res.total_missing).toBe(3); // E ("31") no longer flagged
	expect(res.counts.by_reason).toEqual({ missing: 3, incomplete: 0 });
	expect(res.counts.osm_fix_available).toBe(1); // only B now
	expect(res.locations.map((l) => l.id)).not.toContain('E');
	store.close();
});

test('include_unfixable=false returns only the OSM-fixable work list', async () => {
	const { store, db } = fixture();
	const res = await findMissingAddress(store, db, { include_unfixable: false });
	expect(res.locations.map((l) => l.id)).toEqual(['B', 'E']);
	expect(res.total_missing).toBe(4); // still counted in full
	expect(res.returned).toBe(2);
	expect(res.additional).toBe(2); // C and D exist but are excluded from the list
	expect(res.counts.osm_has_no_address).toBe(1);
	expect(res.counts.no_osm_match).toBe(1);
	store.close();
});

test('closed (soft-deleted) locations are excluded from the scan', async () => {
	const { store } = fixture();
	const db = fakeD1([
		// Born-closed tombstone: address-less AND no staging POI — must not surface.
		{
			id: 'Z',
			name: 'Departed Diner',
			latitude: 49.3,
			longitude: -123.12,
			...NO_ADDR,
			closed_at: '2026-01-01T00:00:00Z'
		}
	]);
	const res = await findMissingAddress(store, db, {});
	expect(res.scanned).toBe(0);
	expect(res.total_missing).toBe(0);
	expect(res.locations).toEqual([]);
	store.close();
});

test('limit caps the returned set and additional reports the remainder', async () => {
	const { store, db } = fixture();
	const res = await findMissingAddress(store, db, { limit: 1 });
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(3);
	expect(res.locations.map((l) => l.id)).toEqual(['B']); // actionable first
	store.close();
});

test('a dismissal pins WHICH parts were missing — losing another part re-flags', async () => {
	const { splitDismissKey } = await import('./audit-dismiss');
	const store = storeWith([]);
	const partial = { id: 'P', name: 'No Street Cart', latitude: 49.28, longitude: -123.12 };
	const db = fakeD1([
		{ ...partial, street: null, city: 'Vancouver', region: 'BC', postcode: null, country: 'CA' }
	]);
	const first = await findMissingAddress(store, db, {});
	expect(first.locations.length).toBe(1);
	expect(first.locations[0].dismiss_key).toBe('P#missing:street');

	const { subject, fingerprint } = splitDismissKey(first.locations[0].dismiss_key)!;
	const dismissals = new Map([
		[subject, { fingerprint, reason: 'venue has no street line', dismissed_at: '2026-07-09' }]
	]);
	const suppressed = await findMissingAddress(store, db, { dismissals });
	expect(suppressed.locations.length).toBe(0);
	expect(suppressed.suppressed_dismissed).toBe(1);
	expect(suppressed.total_missing).toBe(0);

	// The city later wiped too → different missing_parts → different fingerprint → re-flags.
	const worse = fakeD1([
		{ ...partial, street: null, city: null, region: 'BC', postcode: null, country: 'CA' }
	]);
	const reflagged = await findMissingAddress(store, worse, { dismissals });
	expect(reflagged.locations.length).toBe(1);
	expect(reflagged.locations[0].dismiss_key).toBe('P#missing:street,city');
	expect(reflagged.suppressed_dismissed).toBe(0);
	store.close();
});
