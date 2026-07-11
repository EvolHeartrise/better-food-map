import { expect, test } from 'bun:test';
import type { OvertureEateryRow } from './eateries';
import {
	buildOsmNameMatcher,
	dedupLeads,
	leadFromRow,
	leadNormalizedName,
	type OvertureLead
} from './leads';

const CENTRE = { lat: 49.2827, lon: -123.1207 };
// ~1 degree latitude ≈ 111 km, so 0.001 ≈ 111 m and 0.003 ≈ 333 m.
const LAT_100M = 0.0009;
const LAT_300M = 0.0027;

function ndjsonRow(over: Partial<OvertureEateryRow> = {}): OvertureEateryRow {
	return {
		id: 'ov1',
		name: 'Tim Hortons',
		category: 'coffee_shop',
		hierarchy: ['food_and_drink', 'non_alcoholic_beverage_venue', 'coffee_shop'],
		confidence: 0.95,
		operating_status: 'open',
		brand_wikidata: 'Q175106',
		brand_name: 'Tim Hortons',
		lon: CENTRE.lon,
		lat: CENTRE.lat,
		freeform: '123 Main St',
		locality: 'Vancouver',
		addr_region: 'BC',
		postcode: 'V6B 1A1',
		country: 'CA',
		website: 'https://example.com',
		phone: '+16045550100',
		social: null,
		datasets: ['meta', 'Overture', 'Overture-signals'],
		province: 'British Columbia',
		...over
	};
}

function lead(over: Partial<OvertureLead> & Pick<OvertureLead, 'overture_id'>): OvertureLead {
	return {
		name: 'Tim Hortons',
		brand_name: null,
		brand_wikidata: null,
		category: 'coffee_shop',
		bucket: 'cafe',
		confidence: 0.9,
		latitude: CENTRE.lat,
		longitude: CENTRE.lon,
		street: null,
		city: null,
		region: null,
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

test('leadFromRow maps row fields, bucket and primary dataset', () => {
	const l = leadFromRow(ndjsonRow(), 'BC', '2026-06-17.0');
	expect(l.overture_id).toBe('ov1');
	expect(l.bucket).toBe('cafe'); // non_alcoholic_beverage_venue subtree
	expect(l.primary_dataset).toBe('meta'); // Overture/Overture-signals skipped
	expect(l.street).toBe('123 Main St');
	expect(l.city).toBe('Vancouver');
	expect(l.region).toBe('BC');
	expect(l.province).toBe('BC');
	expect(l.dup_count).toBe(1);
	expect(l.release).toBe('2026-06-17.0');
	expect(leadFromRow(ndjsonRow({ confidence: null, datasets: null }), 'BC', 'r').confidence).toBe(
		0
	);
	expect(leadFromRow(ndjsonRow({ datasets: ['Overture'] }), 'BC', 'r').primary_dataset).toBe(
		'Overture'
	);
});

test('leadNormalizedName falls back to the brand name', () => {
	expect(leadNormalizedName({ name: "Wendy's", brand_name: null })).toBe('wendys');
	expect(leadNormalizedName({ name: null, brand_name: 'A & W' })).toBe('aandw');
	expect(leadNormalizedName({ name: null, brand_name: null })).toBe('');
});

test('buildOsmNameMatcher matches name-related POIs within the radius only', () => {
	const matcher = buildOsmNameMatcher([
		{ normalized_name: 'timhortons', latitude: CENTRE.lat + LAT_300M, longitude: CENTRE.lon },
		{ normalized_name: 'starbucks', latitude: CENTRE.lat, longitude: CENTRE.lon }
	]);
	// ~300 m away, related name ("Tim Hortons Cafe and Bake Shop" contains it).
	expect(matcher('timhortonscafeandbakeshop', CENTRE.lat, CENTRE.lon)).toBe(true);
	// Unrelated name at distance 0 never matches.
	expect(matcher('wendys', CENTRE.lat, CENTRE.lon)).toBe(false);
	// Same name but past 500 m.
	expect(matcher('timhortons', CENTRE.lat + 0.009, CENTRE.lon)).toBe(false);
	// Nameless rows are unmatchable.
	expect(matcher('', CENTRE.lat, CENTRE.lon)).toBe(false);
});

test('dedupLeads collapses name-related leads within 150 m onto the highest confidence', () => {
	const input = [
		lead({ overture_id: 'low', confidence: 0.86, latitude: CENTRE.lat + LAT_100M }),
		lead({ overture_id: 'high', confidence: 0.97 }),
		lead({
			overture_id: 'variant',
			name: 'Tim Hortons Cafe and Bake Shop',
			confidence: 0.9,
			latitude: CENTRE.lat - LAT_100M
		})
	];
	const out = dedupLeads(input);
	expect(out).toHaveLength(1);
	expect(out[0].overture_id).toBe('high');
	expect(out[0].dup_count).toBe(3);
	// Inputs are never mutated.
	expect(input.every((l) => l.dup_count === 1)).toBe(true);
});

test('dedupLeads keeps different names, far duplicates and nameless rows apart', () => {
	const out = dedupLeads([
		lead({ overture_id: 'a', confidence: 0.95 }),
		lead({ overture_id: 'b', name: 'Subway', confidence: 0.9 }), // same spot, different name
		lead({ overture_id: 'c', confidence: 0.9, latitude: CENTRE.lat + LAT_300M }), // same name, ~300 m
		lead({ overture_id: 'd', name: null, confidence: 0.9 }), // nameless: never collapses
		lead({ overture_id: 'e', name: null, confidence: 0.89 })
	]);
	expect(out.map((l) => l.overture_id).toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
	expect(out.every((l) => l.dup_count === 1)).toBe(true);
});

test('dedupLeads matches on the brand name when the row name is missing', () => {
	const out = dedupLeads([
		lead({ overture_id: 'named', confidence: 0.95 }),
		lead({ overture_id: 'brandonly', name: null, brand_name: 'Tim Hortons', confidence: 0.9 })
	]);
	expect(out).toHaveLength(1);
	expect(out[0].overture_id).toBe('named');
	expect(out[0].dup_count).toBe(2);
});
