import { expect, test } from 'bun:test';
import type { D1Like, D1PreparedLike } from '../../src/lib/server/db';
import type { OvertureLead } from './leads';
import { OvertureLeadsStore } from './leads-store';
import { searchOvertureLeads } from './search-leads';

const CENTRE = { lat: 49.2827, lon: -123.1207 };
const LAT_300M = 0.0027;

interface ExistingLoc {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
}

/**
 * Minimal D1Like answering only the "existing locations in bbox" query,
 * filtering an in-memory list by the four bound bbox params (as in
 * search-poi.test.ts).
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

function lead(over: Partial<OvertureLead> & Pick<OvertureLead, 'overture_id'>): OvertureLead {
	return {
		name: 'Tim Hortons',
		brand_name: 'Tim Hortons',
		brand_wikidata: 'Q175106',
		category: 'coffee_shop',
		bucket: 'cafe',
		confidence: 0.9,
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		street: '123 Main St',
		city: 'Vancouver',
		region: 'BC',
		postcode: null,
		province: 'BC',
		website: null,
		phone: null,
		primary_dataset: 'meta',
		dup_count: 1,
		release: 'test',
		...over
	};
}

function storeWith(leads: OvertureLead[]): OvertureLeadsStore {
	const store = OvertureLeadsStore.open(':memory:');
	store.rebuild(leads);
	return store;
}

test('rebuild is drop-and-recreate (idempotent)', () => {
	const store = OvertureLeadsStore.open(':memory:');
	store.rebuild([lead({ overture_id: 'a' }), lead({ overture_id: 'b' })]);
	store.rebuild([lead({ overture_id: 'a' })]);
	expect(store.count()).toBe(1);
	store.close();
});

test('openReadonly demands an existing leads table', () => {
	expect(() => OvertureLeadsStore.openReadonly('/nonexistent/osm-poi.sqlite')).toThrow(
		/build-leads/
	);
});

test('junk guard: independents need 0.9 by default, an explicit floor overrides', async () => {
	const store = storeWith([
		lead({ overture_id: 'branded', confidence: 0.86 }),
		lead({
			overture_id: 'indie',
			name: 'Wine Rack',
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.86
		}),
		lead({
			overture_id: 'indie-solid',
			name: 'Loyal Cafe',
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.93
		})
	]);
	const byDefault = await searchOvertureLeads(store, null, { exclude_existing: false });
	expect(byDefault.leads.map((l) => l.overture_id).toSorted()).toEqual(['branded', 'indie-solid']);
	const lowered = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		min_confidence: 0.85
	});
	expect(lowered.total_matching).toBe(3);
	const raised = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		min_confidence: 0.95
	});
	expect(raised.total_matching).toBe(0);
	store.close();
});

test('brands_only keeps only rows with a brand signal', async () => {
	const store = storeWith([
		lead({ overture_id: 'qid', brand_name: null }),
		lead({ overture_id: 'brandname', brand_wikidata: null }),
		lead({
			overture_id: 'indie',
			name: 'Solo Bistro',
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.95
		})
	]);
	const res = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		brands_only: true
	});
	expect(res.leads.map((l) => l.overture_id).toSorted()).toEqual(['brandname', 'qid']);
	store.close();
});

test('name filter matches the brand name too; city and province filter', async () => {
	const store = storeWith([
		lead({ overture_id: 'a', name: 'TH #1234', brand_name: 'Tim Hortons' }),
		lead({ overture_id: 'b', name: 'Subway', brand_name: null, city: 'Burnaby' }),
		lead({ overture_id: 'c', name: 'Subway', brand_name: null, province: 'ON', city: 'Ottawa' })
	]);
	const byName = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		name: 'hortons'
	});
	expect(byName.leads.map((l) => l.overture_id)).toEqual(['a']);
	const byCity = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		city: 'burn'
	});
	expect(byCity.leads.map((l) => l.overture_id)).toEqual(['b']);
	const byProvince = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		province: 'ON'
	});
	expect(byProvince.leads.map((l) => l.overture_id)).toEqual(['c']);
	store.close();
});

test('pages like list_locations: confidence-ordered, limit/offset/has_more', async () => {
	const store = storeWith([
		lead({ overture_id: 'c90', confidence: 0.9 }),
		lead({ overture_id: 'a99', confidence: 0.99 }),
		lead({ overture_id: 'b95', confidence: 0.95 })
	]);
	const page1 = await searchOvertureLeads(store, null, { exclude_existing: false, limit: 2 });
	expect(page1.leads.map((l) => l.overture_id)).toEqual(['a99', 'b95']);
	expect(page1).toMatchObject({ returned: 2, has_more: true, total_matching: 3, offset: 0 });
	const page2 = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		limit: 2,
		offset: 2
	});
	expect(page2.leads.map((l) => l.overture_id)).toEqual(['c90']);
	expect(page2).toMatchObject({ returned: 1, has_more: false, total_matching: 3 });
	store.close();
});

test('centre+radius returns nearest-first with distance_m, excludes leads outside', async () => {
	const store = storeWith([
		lead({ overture_id: 'near', latitude: CENTRE.lat + LAT_300M, confidence: 0.99 }),
		lead({ overture_id: 'here', confidence: 0.86 }),
		lead({ overture_id: 'far', latitude: CENTRE.lat + 0.5 })
	]);
	const res = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		radius_km: 1
	});
	expect(res.leads.map((l) => l.overture_id)).toEqual(['here', 'near']);
	expect(res.leads[0].distance_m).toBe(0);
	expect(res.leads[1].distance_m).toBeGreaterThan(250);
	expect(res.total_matching).toBe(2);
	store.close();
});

test('a lead position is exposed only as approx_* — a spread can never be a location', async () => {
	const store = storeWith([lead({ overture_id: 'a' })]);
	const res = await searchOvertureLeads(store, null, { exclude_existing: false });
	const candidate = res.leads[0] as Record<string, unknown>;
	expect(candidate.approx_latitude).toBe(CENTRE.lat);
	expect(candidate.approx_longitude).toBe(CENTRE.lon);
	// The create_locations field names must be absent (the anti-footgun shape).
	expect('latitude' in candidate).toBe(false);
	expect('longitude' in candidate).toBe(false);
	store.close();
});

test('exclude_existing drops leads covered by a name-related D1 record within 500 m', async () => {
	const store = storeWith([
		// "TH #1234" relates to recorded "Tim Hortons" ~300 m away → covered.
		lead({ overture_id: 'covered', name: 'Tim Hortons #1234' }),
		// Same spot as a recorded venue with an unrelated name → kept.
		lead({
			overture_id: 'neighbour',
			name: 'Subway',
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.95
		}),
		// Nameless lead can never be proven covered → kept.
		lead({
			overture_id: 'nameless',
			name: null,
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.95
		})
	]);
	const db = fakeD1([
		{ id: 'live', name: 'Tim Hortons', latitude: CENTRE.lat + LAT_300M, longitude: CENTRE.lon }
	]);
	const res = await searchOvertureLeads(store, db, {});
	expect(res.leads.map((l) => l.overture_id).toSorted()).toEqual(['nameless', 'neighbour']);
	expect(res.excluded_existing).toBe(1);
	expect(res.total_matching).toBe(2);
	store.close();
});

test('suppression uses the strict relation — no boundary-less substring matches', async () => {
	// Old-rule regression: "aandw" ⊂ "pizzaandwings" would suppress this lead
	// near any imported A&W, forever.
	const store = storeWith([
		lead({
			overture_id: 'pizza',
			name: 'Fiamo Pizza and Wine Bar',
			brand_name: null,
			brand_wikidata: null,
			confidence: 0.95
		})
	]);
	const db = fakeD1([
		{ id: 'aw', name: 'A&W', latitude: CENTRE.lat + LAT_300M, longitude: CENTRE.lon }
	]);
	const res = await searchOvertureLeads(store, db, {});
	expect(res.leads.map((l) => l.overture_id)).toEqual(['pizza']);
	expect(res.excluded_existing).toBe(0);
	store.close();
});

test('scan cap reports scan_truncated only when rows actually overflow it', async () => {
	const store = storeWith([
		lead({ overture_id: 'a' }),
		lead({ overture_id: 'b' }),
		lead({ overture_id: 'c' })
	]);
	const truncated = await searchOvertureLeads(store, null, {
		exclude_existing: false,
		scanCap: 2
	});
	expect(truncated.scan_truncated).toBe(true);
	expect(truncated.total_matching).toBe(2);
	// Exactly scanCap rows in the area is NOT truncation (the +1 probe proves it).
	const exact = await searchOvertureLeads(store, null, { exclude_existing: false, scanCap: 3 });
	expect(exact.scan_truncated).toBe(false);
	expect(exact.total_matching).toBe(3);
	store.close();
});
