import { expect, test } from 'bun:test';
import type { OvertureEateryRow } from './eateries';
import {
	buildOsmNameMatcher,
	dedupLeads,
	leadFromRow,
	leadNameTokens,
	nameTokens,
	tokensRelated,
	type OvertureLead
} from './leads';

/** tokensRelated over raw names, for readable assertions. */
const related = (a: string, b: string): boolean => tokensRelated(nameTokens(a), nameTokens(b));

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

test('nameTokens folds case/diacritics/apostrophes and splits on word boundaries', () => {
	expect(nameTokens("McDonald's")).toEqual(['mcdonalds']);
	expect(nameTokens('A&W')).toEqual(['a', 'and', 'w']);
	expect(nameTokens('Yama-No-Kami')).toEqual(['yama', 'no', 'kami']);
	expect(nameTokens('Café Crème!')).toEqual(['cafe', 'creme']);
	expect(nameTokens(null)).toEqual([]);
});

test('leadNameTokens falls back to the brand name', () => {
	expect(leadNameTokens({ name: "Wendy's", brand_name: null })).toEqual(['wendys']);
	expect(leadNameTokens({ name: null, brand_name: 'A & W' })).toEqual(['a', 'and', 'w']);
	expect(leadNameTokens({ name: null, brand_name: null })).toEqual([]);
});

test('tokensRelated accepts containment/spacing/apostrophe variants', () => {
	expect(related('Earls', 'Earls Kitchen + Bar')).toBe(true);
	expect(related('KFC', 'Taco Bell / KFC')).toBe(true);
	expect(related('Tim Hortons', 'Tim Hortons Cafe and Bake Shop')).toBe(true);
	expect(related('Subway #123', 'Subway')).toBe(true);
	expect(related('PizzaHut', 'Pizza Hut')).toBe(true); // spacing variant (joined equality)
	expect(related("McDonald's", 'McDonalds')).toBe(true);
	expect(related('A&W', 'A and W Restaurant')).toBe(true);
});

test('tokensRelated rejects the boundary-less substring false positives', () => {
	// The old substring rule: "aandw" ⊂ "pizzaandwings" falsely gated 9 real
	// venues out of the pool at build time.
	expect(related('A&W', 'Pizza and Wings')).toBe(false);
	expect(related('A&W', 'Fiamo Pizza and Wine Bar')).toBe(false);
	expect(related('A&W', 'UNA Pizza and Wine')).toBe(false);
	// …and "amano" ⊂ "yamanokami" falsely merged two distinct venues 81 m apart.
	expect(related('A Mano', 'Yama-No-Kami')).toBe(false);
	// Too-short fragments still prove nothing.
	expect(related('BK', 'BK Lounge Whopper Bar')).toBe(false);
	expect(tokensRelated([], nameTokens('Subway'))).toBe(false);
});

test('buildOsmNameMatcher matches name-related POIs within the radius only', () => {
	const matcher = buildOsmNameMatcher([
		{ name: 'Tim Hortons', latitude: CENTRE.lat + LAT_300M, longitude: CENTRE.lon },
		{ name: 'Starbucks', latitude: CENTRE.lat, longitude: CENTRE.lon },
		{ name: 'A&W', latitude: CENTRE.lat, longitude: CENTRE.lon }
	]);
	// ~300 m away, related name ("Tim Hortons Cafe and Bake Shop" contains it).
	expect(matcher(nameTokens('Tim Hortons Cafe and Bake Shop'), CENTRE.lat, CENTRE.lon)).toBe(true);
	// Unrelated name at distance 0 never matches.
	expect(matcher(nameTokens("Wendy's"), CENTRE.lat, CENTRE.lon)).toBe(false);
	// Substring-across-word-boundaries must not gate a real venue (old-rule regression).
	expect(matcher(nameTokens('Pizza and Wings'), CENTRE.lat, CENTRE.lon)).toBe(false);
	// Same name but past 500 m.
	expect(matcher(nameTokens('Tim Hortons'), CENTRE.lat + 0.009, CENTRE.lon)).toBe(false);
	// Nameless rows are unmatchable.
	expect(matcher([], CENTRE.lat, CENTRE.lon)).toBe(false);
});

test('the build gate keys off leadNameTokens, so brand-only rows are gated too', () => {
	const matcher = buildOsmNameMatcher([
		{ name: 'Yu Seafood', latitude: CENTRE.lat, longitude: CENTRE.lon }
	]);
	const brandOnly = leadFromRow(
		ndjsonRow({ name: null, brand_name: 'Yu Seafood', brand_wikidata: null }),
		'BC',
		'r'
	);
	expect(matcher(leadNameTokens(brandOnly), CENTRE.lat, CENTRE.lon)).toBe(true);
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

test('dedupLeads keeps same-brand NEIGHBOURS with different street lines apart', () => {
	// The real "Country Style" pair: two branches 78 m apart, distinct streets.
	const out = dedupLeads([
		lead({
			overture_id: 'bloor',
			name: 'Country Style',
			street: '299 Bloor Street West',
			confidence: 0.95
		}),
		lead({
			overture_id: 'devonshire',
			name: 'Country Style',
			street: '100 Devonshire Place',
			confidence: 0.9,
			latitude: CENTRE.lat + 0.0007 // ~78 m
		})
	]);
	expect(out.map((l) => l.overture_id).toSorted()).toEqual(['bloor', 'devonshire']);
	expect(out.every((l) => l.dup_count === 1)).toBe(true);
});

test('dedupLeads collapses when street lines agree (normalized) or one is missing', () => {
	const sameStreet = dedupLeads([
		lead({ overture_id: 'a', street: '299 Bloor Street West', confidence: 0.95 }),
		lead({
			overture_id: 'b',
			street: '299  Bloor Street West.', // cosmetic variation only
			confidence: 0.9,
			latitude: CENTRE.lat + LAT_100M
		})
	]);
	expect(sameStreet).toHaveLength(1);
	expect(sameStreet[0].dup_count).toBe(2);

	const missingStreet = dedupLeads([
		lead({ overture_id: 'a', street: '299 Bloor Street West', confidence: 0.95 }),
		lead({ overture_id: 'b', street: null, confidence: 0.9, latitude: CENTRE.lat + LAT_100M })
	]);
	expect(missingStreet).toHaveLength(1);
	expect(missingStreet[0].dup_count).toBe(2);
});
