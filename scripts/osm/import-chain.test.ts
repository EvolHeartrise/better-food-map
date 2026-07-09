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
	brand_id?: string | null;
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

const AREA = { bbox: { minLat: 48, minLng: -125, maxLat: 51, maxLng: -120 } };

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

test('normalized scan reaches spelling variants the LIKE scan cannot (#88)', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' }),
		// "&" written out: no LIKE term ("A&W"/"AW") is a substring of this name,
		// but it normalizes identically ("aandw") — the equality scan must find it.
		row({ osm_id: 'n2', latitude: 49.2, longitude: -123.2, name: 'A and W' }),
		// Superstring variants still need their own allowlist entry — they don't
		// normalize-equal, and when their raw spelling also evades every LIKE term
		// they stay out of the histogram too (the residual, vet-by-QID gap).
		row({ osm_id: 'n3', latitude: 49.3, longitude: -123.3, name: 'A and W Restaurant' })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['A&W']
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2']);
	const byName = new Map(selection.name_buckets.map((b) => [b.name, b]));
	expect(byName.get('A and W')?.matched).toBe(true);
	expect(byName.get('A and W Restaurant')).toBeUndefined();
});

test('normalized scan folds hyphens, periods and accents like the matcher (#88)', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'Tim-Hortons' }),
		row({ osm_id: 'n2', latitude: 49.2, longitude: -123.2, name: 'Café Crème' }),
		row({ osm_id: 'n3', latitude: 49.3, longitude: -123.3, name: 'Mr Sub' })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['Tim Hortons', 'Cafe Creme', 'Mr. Sub']
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2', 'n3']);
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

test('surfaces an unlinked independent lookalike as unlinked_existing (issue #242)', async () => {
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' }),
		row({ osm_id: 'n2', latitude: 49.5, longitude: -123.5, name: 'A&W' })
	]);
	// n1's spot already holds an INDEPENDENT venue (brand_id null) — the stray A&W
	// on a stale private menu. With the chain's brandId given, it's excluded from
	// the import (no duplicate pin) AND surfaced for adoption.
	const db = fakeD1([
		{ id: 'stray', name: 'A&W', latitude: 49.1, longitude: -123.1, brand_id: null }
	]);
	const selection = await selectChainCandidates(store, db, {
		area: AREA,
		nameMatch: ['A&W'],
		brandId: 'brand-aw'
	});
	expect(selection.matched.map((p) => p.osm_id)).toEqual(['n2']);
	expect(selection.excluded_existing).toBe(1);
	expect(selection.unlinked_existing).toEqual([
		{ id: 'stray', name: 'A&W', brand_id: null, osm_id: 'n1' }
	]);
});

test('an already-linked branch of the same chain is NOT surfaced as unlinked', async () => {
	const store = storeWith([row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' })]);
	// The existing venue IS a branch of the chain being imported → an ordinary
	// already-on-the-map exclusion, no adoption needed.
	const db = fakeD1([
		{ id: 'branch', name: 'A&W', latitude: 49.1, longitude: -123.1, brand_id: 'brand-aw' }
	]);
	const selection = await selectChainCandidates(store, db, {
		area: AREA,
		nameMatch: ['A&W'],
		brandId: 'brand-aw'
	});
	expect(selection.excluded_existing).toBe(1);
	expect(selection.unlinked_existing).toEqual([]);
});

test('without brandId, unlinked_existing stays empty (opt-in reporting)', async () => {
	const store = storeWith([row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' })]);
	const db = fakeD1([
		{ id: 'stray', name: 'A&W', latitude: 49.1, longitude: -123.1, brand_id: null }
	]);
	const selection = await selectChainCandidates(store, db, { area: AREA, nameMatch: ['A&W'] });
	expect(selection.excluded_existing).toBe(1);
	expect(selection.unlinked_existing).toEqual([]);
});

test('one unlinked venue shadowing several POIs is reported once', async () => {
	// Two staging nodes for the same venue (OSM double-mapping), both within
	// SAME_NAME_M of the one independent row — the stray is listed a single time.
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'A&W' }),
		row({ osm_id: 'n2', latitude: 49.10005, longitude: -123.1, name: 'A&W' })
	]);
	const db = fakeD1([
		{ id: 'stray', name: 'A&W', latitude: 49.1, longitude: -123.1, brand_id: null }
	]);
	const selection = await selectChainCandidates(store, db, {
		area: AREA,
		nameMatch: ['A&W'],
		brandId: 'brand-aw'
	});
	expect(selection.unlinked_existing.map((u) => u.id)).toEqual(['stray']);
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

test('brand_wikidata accepts variant names on two-signal agreement, never on QID alone', async () => {
	const qidTags = (name?: string) =>
		JSON.stringify({ 'brand:wikidata': 'Q175106', ...(name ? { brand: name } : {}) });
	const store = storeWith([
		row({
			osm_id: 'n1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Tim Hortons',
			tags_json: qidTags()
		}),
		// Variant name + the chain's QID: two signals agree → imported.
		row({
			osm_id: 'n2',
			latitude: 49.2,
			longitude: -123.2,
			name: 'Tim Hortons Express',
			tags_json: qidTags()
		}),
		// Conflicting name carrying the chain's QID (real OSM mistag pattern) → NOT
		// imported; surfaced in its bucket with the QID annotation instead.
		row({
			osm_id: 'n3',
			latitude: 49.3,
			longitude: -123.3,
			name: 'Second Cup',
			tags_json: qidTags()
		}),
		// Variant name WITHOUT the QID → not imported (single signal).
		row({ osm_id: 'n4', latitude: 49.4, longitude: -123.4, name: 'Tim Hortons Express' })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['Tim Hortons'],
		brandWikidata: 'Q175106'
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2']);
	expect(selection.matched_by_brand).toBe(1);
	const byName = new Map(selection.name_buckets.map((b) => [b.name, b]));
	expect(byName.get('Second Cup')?.matched).toBe(false);
	expect(byName.get('Second Cup')?.brand_wikidata).toBe('Q175106');
	// The QID-less variant shares a bucket with the QID-carrying one; the bucket is
	// matched (one POI imported) and annotated with the dominant QID.
	expect(byName.get('Tim Hortons Express')?.matched).toBe(true);
	expect(byName.get('Tim Hortons Express')?.brand_wikidata_count).toBe(1);
});

test('name_buckets carry the dominant brand:wikidata annotation without brandWikidata set', async () => {
	const store = storeWith([
		row({
			osm_id: 'n1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Chain',
			tags_json: JSON.stringify({ 'brand:wikidata': 'Q1' })
		}),
		row({
			osm_id: 'n2',
			latitude: 49.2,
			longitude: -123.2,
			name: 'Chain',
			tags_json: JSON.stringify({ 'brand:wikidata': 'Q1' })
		}),
		row({
			osm_id: 'n3',
			latitude: 49.3,
			longitude: -123.3,
			name: 'Chain',
			tags_json: JSON.stringify({ 'brand:wikidata': 'Q2' })
		}),
		row({ osm_id: 'n4', latitude: 49.4, longitude: -123.4, name: 'Chain' })
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['Chain']
	});
	const bucket = selection.name_buckets.find((b) => b.name === 'Chain');
	expect(bucket?.count).toBe(4);
	expect(bucket?.brand_wikidata).toBe('Q1');
	expect(bucket?.brand_wikidata_count).toBe(2);
	expect(selection.matched_by_brand).toBe(0);
});

test('country scope drops foreign-signalled POIs and keeps unknowns', async () => {
	const store = storeWith([
		// Own addr:state says Maine → US → dropped from a CA-scoped import.
		row({
			osm_id: 'us1',
			latitude: 47.25,
			longitude: -68.6,
			name: 'Chain',
			tags_json: JSON.stringify({
				'addr:housenumber': '100',
				'addr:street': 'West Main Street',
				'addr:city': 'Fort Kent',
				'addr:state': 'ME'
			})
		}),
		// Canadian admin join → kept.
		row({
			osm_id: 'ca1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Chain',
			admin_city: 'Vancouver',
			admin_region: 'BC'
		}),
		// No country signal at all → kept (can't be proven foreign).
		row({ osm_id: 'unk1', latitude: 49.2, longitude: -123.2, name: 'Chain' })
	]);
	const area = { bbox: { minLat: 45, minLng: -125, maxLat: 51, maxLng: -60 } };
	const scoped = await selectChainCandidates(store, fakeD1([]), {
		area,
		nameMatch: ['Chain'],
		country: 'CA'
	});
	expect(scoped.matched.map((p) => p.osm_id).toSorted()).toEqual(['ca1', 'unk1']);
	expect(scoped.excluded_foreign).toBe(1);
	// The foreign POI is excluded before bucketing, so it doesn't pad the histogram.
	expect(scoped.name_buckets.find((b) => b.name === 'Chain')?.count).toBe(2);

	const unscoped = await selectChainCandidates(store, fakeD1([]), {
		area,
		nameMatch: ['Chain']
	});
	expect(unscoped.matched.length).toBe(3);
	expect(unscoped.excluded_foreign).toBe(0);
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

test('brand path: co-branded names are never absorbed, short names skip the overlap floor, QID case folds', async () => {
	const kfcQid = JSON.stringify({ 'brand:wikidata': 'Q524757' });
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 49.1, longitude: -123.1, name: 'KFC', tags_json: kfcQid }),
		// "KFC Express" ⊃ "KFC" is below namesMatch's 4-char overlap floor — the
		// brand path must accept it anyway (the QID is the second signal), even
		// with the QID tagged lower-case in OSM.
		row({
			osm_id: 'n2',
			latitude: 49.2,
			longitude: -123.2,
			name: 'KFC Express',
			tags_json: JSON.stringify({ 'brand:wikidata': 'q524757' })
		}),
		// A co-branded unit carrying the QID: containment holds, but importing it
		// as bare "KFC" would block the other chain — must stay a vetting bucket.
		row({
			osm_id: 'n3',
			latitude: 49.3,
			longitude: -123.3,
			name: 'KFC / Taco Bell',
			tags_json: kfcQid
		})
	]);
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['KFC'],
		brandWikidata: 'Q524757'
	});
	expect(selection.matched.map((p) => p.osm_id).toSorted()).toEqual(['n1', 'n2']);
	expect(selection.matched_by_brand).toBe(1);
	const byName = new Map(selection.name_buckets.map((b) => [b.name, b]));
	expect(byName.get('KFC Express')?.matched_via_brand).toBe(true);
	expect(byName.get('KFC')?.matched_via_brand).toBeUndefined(); // exact allowlist match
	expect(byName.get('KFC / Taco Bell')?.matched).toBe(false);
	expect(byName.get('KFC / Taco Bell')?.brand_wikidata).toBe('Q524757');
});

test('country scope folds spelling variants through normalizeCountry and samples the drops', async () => {
	const store = storeWith([
		row({
			osm_id: 'gb1',
			latitude: 49.1,
			longitude: -123.1,
			name: 'Chain',
			tags_json: JSON.stringify({ 'addr:country': 'UK' })
		}),
		row({
			osm_id: 'ca1',
			latitude: 49.2,
			longitude: -123.2,
			name: 'Chain',
			admin_city: 'Vancouver',
			admin_region: 'BC'
		})
	]);
	// Scope "UK" must fold to GB and keep the UK-signalled POI (whose own signal
	// also folds to GB) — a raw string compare would drop it.
	const selection = await selectChainCandidates(store, fakeD1([]), {
		area: AREA,
		nameMatch: ['Chain'],
		country: 'UK'
	});
	expect(selection.matched.map((p) => p.osm_id)).toEqual(['gb1']);
	expect(selection.excluded_foreign).toBe(1);
	expect(selection.excluded_foreign_sample).toEqual([
		{ osm_id: 'ca1', name: 'Chain', country: 'CA' }
	]);
});

test('drops a branch whose stored venue moved just OUTSIDE the query bbox', async () => {
	// The stored branch's OSM node moved since import: it now sits ~100 m above
	// the bbox's top edge while the staging POI is just inside. The SAME_NAME_M
	// padding on the dedup fetch must still let it block the in-bbox POI.
	const store = storeWith([
		row({ osm_id: 'n1', latitude: 50.9992, longitude: -123.1, name: 'Booster Juice' }),
		row({ osm_id: 'n2', latitude: 49.5, longitude: -123.5, name: 'Booster Juice' })
	]);
	// AREA's maxLat is 51; the stored row sits ~100 m north of it.
	const db = fakeD1([{ id: 'loc1', name: 'Booster Juice', latitude: 51.0001, longitude: -123.1 }]);
	const selection = await selectChainCandidates(store, db, {
		area: AREA,
		nameMatch: ['Booster Juice']
	});
	expect(selection.matched.map((p) => p.osm_id)).toEqual(['n2']);
	expect(selection.excluded_existing).toBe(1);
});
