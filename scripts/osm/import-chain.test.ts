import { test, expect } from 'bun:test';
import { selectChainCandidates } from './import-chain';
import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';
import type { D1Like, D1PreparedLike } from '../../src/lib/server/db';

interface ExistingLoc {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
}

/** Minimal D1Like answering only the "existing locations in bbox" query. */
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
		osm_class: 'fast_food',
		suggested_category: 'fast_food',
		cuisine: null,
		address: null,
		phone: null,
		website: null,
		opening_hours: null,
		diet_markers: [],
		tags_json: '{}',
		admin_city: null,
		admin_region: null,
		...over
	};
}

function storeWith(rows: PoiRow[]): OsmPoiStore {
	const store = OsmPoiStore.open(':memory:');
	store.insertMany('test', rows);
	return store;
}

const AREA = { bbox: { minLat: 48, minLon: -125, maxLat: 51, maxLon: -120 } };

test('matches strictly by normalized name and histograms everything else', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: "Harvey's" }),
		row({ osm_id: 'n2', latitude: 49.2, longitude: -123.2, name: 'Harveys' }), // punctuation folds
		row({ osm_id: 'n3', latitude: 49.3, longitude: -123.3, name: "HARVEY'S" }), // case folds
		row({ osm_id: 'n4', latitude: 49.4, longitude: -123.4, name: 'Browns Social House - Harvey' }),
		row({ osm_id: 'n5', latitude: 49.5, longitude: -123.5, name: "Harvey's Confectionery" }),
		row({ osm_id: 'n6', latitude: 49.6, longitude: -123.6, name: null })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ["Harvey's"]
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2', 'n3']);
	// Superstring look-alikes the scans surface are counted, never imported; a name
	// the scan terms don't even reach ("… - Harvey" has no "Harvey's"/"Harveys")
	// stays out of the histogram entirely.
	const byName = new Map(selection.name_buckets.map((b) => [b.name, b]));
	expect(byName.get("Harvey's Confectionery")?.matched).toBe(false);
	expect(byName.get('Browns Social House - Harvey')).toBeUndefined();
	expect(byName.get("Harvey's")?.matched).toBe(true);
	expect(selection.excluded_existing).toBe(0);
	expect(selection.scan_truncated).toBe(false);
});

test('multiple name_match terms union without duplicating a POI', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: "Mary Brown's" }),
		row({ osm_id: 'n2', latitude: 49.2, longitude: -123.2, name: "Mary Brown's Chicken" })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		// "Mary Brown's" is a substring of both rows' names, so both scans see n2 —
		// the union and strict matching must still yield each POI exactly once.
		nameMatch: ["Mary Brown's", "Mary Brown's Chicken"]
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2']);
	expect(selection.matched.length).toBe(2);
});

test('drops branches already on the map, counting them', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'Booster Juice' }),
		row({ osm_id: 'n2', latitude: 49.5, longitude: -123.5, name: 'Booster Juice' })
	]);
	// n1 is already imported (identical coordinates — the OSM-verbatim invariant).
	const db = fakeD1([{ id: 'loc1', name: 'Booster Juice', latitude: 49.1, longitude: -123.1 }]);
	const selection = await selectChainCandidates(store, db, {
		area: AREA,
		nameMatch: ['Booster Juice']
	});
	expect(selection.matched.map((p) => p.osm_id)).toEqual(['n2']);
	expect(selection.excluded_existing).toBe(1);
});

test('centre queries refine to the circle and order nearest-first', async () => {
	const store = storeWith([
		row({ osm_id: 'far', latitude: 50.9, longitude: -123.1, name: 'Chain' }),
		row({ osm_id: 'near', latitude: 49.11, longitude: -123.1, name: 'Chain' }),
		row({ osm_id: 'mid', latitude: 49.4, longitude: -123.1, name: 'Chain' })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: { latitude: 49.1, longitude: -123.1, radius_km: 50 },
		nameMatch: ['Chain']
	});
	// "far" (~200 km) is outside the 50 km circle; the rest sort by distance.
	expect(selection.matched.map((p) => p.osm_id)).toEqual(['near', 'mid']);
});

test('reports scan truncation at the cap', async () => {
	const rows = Array.from({ length: 30 }, (_, i) =>
		row({ osm_id: `n${i + 1}`, latitude: 49 + i * 0.01, longitude: -123, name: 'Chain' })
	);
	const store = storeWith(rows);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['Chain'],
		scanCap: 30
	});
	expect(selection.scan_truncated).toBe(true);
});

test('partitionImportable separates street-less POIs so max cannot be blocked by them', async () => {
	const { partitionImportable } = await import('./import-chain');
	const pois = [
		// Fully resolvable: own addr tags.
		row({
			osm_id: 'n1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Chain',
			tags_json: JSON.stringify({
				'addr:housenumber': '1',
				'addr:street': 'Main St',
				'addr:city': 'Vancouver',
				'addr:state': 'BC'
			})
		}),
		// Resolvable via enriched line + admin join.
		row({
			osm_id: 'n2',
			latitude: 49.2,
			longitude: -123.2,
			name: 'Chain',
			address: '465 Merecroft Road',
			admin_city: 'Campbell River',
			admin_region: 'BC'
		}),
		// Street-less: admin city/region only.
		row({
			osm_id: 'n3',
			latitude: 49.3,
			longitude: -123.3,
			name: 'Chain',
			admin_city: 'Surrey',
			admin_region: 'BC'
		}),
		// Nothing at all.
		row({ osm_id: 'n4', latitude: 49.4, longitude: -123.4, name: 'Chain' })
	];
	const { importable, unresolvable } = partitionImportable(pois);
	expect(importable.map((p) => p.osm_id)).toEqual(['n1', 'n2']);
	expect(unresolvable.count).toBe(2);
	expect(unresolvable.missing_street).toBe(2);
	expect(unresolvable.missing_city_or_region).toBe(0);
	expect(unresolvable.sample_osm_ids).toEqual(['n3', 'n4']);
});
