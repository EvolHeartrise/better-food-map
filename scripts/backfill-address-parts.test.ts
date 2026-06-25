import { expect, test, describe } from 'bun:test';
import {
	osmRefFromSourceUrl,
	pickOsmRef,
	partsFromOsmTags,
	partsFromNominatim,
	parseAddressLine,
	chooseParts,
	chooseStreet,
	normalizeParts,
	type RawParts
} from './backfill-address-parts';

const EMPTY: RawParts = { street: null, city: null, region: null, postcode: null, country: null };

describe('osmRefFromSourceUrl', () => {
	test('parses node/way/relation URLs into lookup + store ids', () => {
		expect(osmRefFromSourceUrl('https://www.openstreetmap.org/node/123')).toMatchObject({
			osm_type: 'node',
			numeric_id: 123,
			lookupId: 'N123',
			storeId: 'n123'
		});
		expect(osmRefFromSourceUrl('https://www.openstreetmap.org/way/456')).toMatchObject({
			lookupId: 'W456',
			storeId: 'w456'
		});
		expect(osmRefFromSourceUrl('https://openstreetmap.org/relation/789')).toMatchObject({
			lookupId: 'R789',
			storeId: 'r789'
		});
	});

	test('returns null for non-OSM URLs', () => {
		expect(osmRefFromSourceUrl('https://example.com/menu')).toBeNull();
	});

	test('pickOsmRef finds the first OSM url among citations', () => {
		expect(
			pickOsmRef(['https://site.example/x', 'https://www.openstreetmap.org/node/9'])?.lookupId
		).toBe('N9');
		expect(pickOsmRef(['https://site.example/x'])).toBeNull();
	});
});

describe('partsFromOsmTags', () => {
	test('composes street and reads city/region/postcode/country', () => {
		expect(
			partsFromOsmTags({
				'addr:housenumber': '1909',
				'addr:street': 'West 4th Avenue',
				'addr:city': 'Vancouver',
				'addr:state': 'British Columbia',
				'addr:postcode': 'V6J 1M5',
				'addr:country': 'CA'
			})
		).toEqual({
			street: '1909 West 4th Avenue',
			city: 'Vancouver',
			region: 'British Columbia',
			postcode: 'V6J 1M5',
			country: 'CA'
		});
	});

	test('falls back through town/village for city and province for region', () => {
		const p = partsFromOsmTags({ 'addr:village': 'Hope', 'addr:province': 'BC' });
		expect(p.city).toBe('Hope');
		expect(p.region).toBe('BC');
	});

	test('street-only tags yield only a street', () => {
		expect(partsFromOsmTags({ 'addr:housenumber': '100', 'addr:street': 'Bayshore Dr' })).toEqual({
			street: '100 Bayshore Dr',
			city: null,
			region: null,
			postcode: null,
			country: null
		});
	});
});

describe('partsFromNominatim', () => {
	test('maps Nominatim address fields, preferring country_code', () => {
		expect(
			partsFromNominatim({
				house_number: '583',
				road: 'Main Street',
				town: 'Vancouver',
				state: 'British Columbia',
				postcode: 'V6A 2V1',
				country: 'Canada',
				country_code: 'ca'
			})
		).toEqual({
			street: '583 Main Street',
			city: 'Vancouver',
			region: 'British Columbia',
			postcode: 'V6A 2V1',
			country: 'ca'
		});
	});

	test('uses the ISO-3166-2 code for region over a bilingual state name', () => {
		const p = partsFromNominatim({
			road: 'Chemin Madawaska',
			state: 'New Brunswick / Nouveau-Brunswick',
			'ISO3166-2-lvl4': 'CA-NB',
			postcode: 'E3Y 1A3',
			country_code: 'ca'
		});
		expect(p.region).toBe('NB');
		expect(p.country).toBe('ca');
	});

	test('falls back through suburb/county for an unincorporated locality', () => {
		expect(
			partsFromNominatim({
				road: 'Leva Avenue',
				suburb: 'Gasoline Alley',
				county: 'Red Deer County'
			}).city
		).toBe('Gasoline Alley');
		expect(
			partsFromNominatim({ road: 'Buffalo Run Boulevard', county: 'Rocky View County' }).city
		).toBe('Rocky View County');
	});
});

describe('parseAddressLine', () => {
	test('parses the independent style (region+postcode joined)', () => {
		expect(parseAddressLine('1909 W 4th Ave, Vancouver, BC V6J 1M5')).toEqual({
			street: '1909 W 4th Ave',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: null
		});
	});

	test('parses the chain style (postcode its own segment) and drops country', () => {
		expect(parseAddressLine('8223 120 St, Delta, BC V4C 6R1, Canada')).toMatchObject({
			street: '8223 120 St',
			city: 'Delta',
			region: 'BC',
			postcode: 'V4C 6R1'
		});
	});

	test('strips parenthetical notes', () => {
		const p = parseAddressLine(
			'7057 120 St, Surrey, BC V4E 2A9, Canada (Scottsdale Centre food court)'
		);
		expect(p.street).toBe('7057 120 St');
		expect(p.city).toBe('Surrey');
		expect(p.postcode).toBe('V4E 2A9');
	});

	test('keeps a region-only last segment (BC is not a country)', () => {
		expect(parseAddressLine('3096 Main St, Vancouver, BC')).toEqual({
			street: '3096 Main St',
			city: 'Vancouver',
			region: 'BC',
			postcode: null,
			country: null
		});
	});

	test('street-only line yields just a street', () => {
		expect(parseAddressLine('100 Bayshore Drive')).toMatchObject({
			street: '100 Bayshore Drive',
			city: null,
			region: null,
			postcode: null
		});
	});

	test('empty input is all null', () => {
		expect(parseAddressLine(null)).toEqual({
			street: null,
			city: null,
			region: null,
			postcode: null,
			country: null
		});
	});
});

describe('chooseStreet', () => {
	test('prefers the candidate with the most leading numbers (house # + numbered street)', () => {
		// Edmonton grid: existing has the house number 8036, Nominatim dropped it.
		expect(chooseStreet(['118 Avenue NW', '8036 118 Ave NW', '118 Avenue NW'])).toBe(
			'8036 118 Ave NW'
		);
	});
	test('keeps trust order on a tie (own street beats a Nominatim cross-street)', () => {
		expect(chooseStreet(['7057 120 St', '7031 70 Avenue'])).toBe('7057 120 St');
	});
	test('handles unit-house-street and bare numbered streets', () => {
		expect(chooseStreet(['104-12888 80 Avenue'])).toBe('104-12888 80 Avenue');
		expect(chooseStreet([null, 'Mitik Street', 'Cambridge Bay'])).toBe('Mitik Street');
	});
	test('returns null when there are no candidates', () => {
		expect(chooseStreet([null, null])).toBeNull();
	});
});

describe('chooseParts', () => {
	test('own street/postcode win; Nominatim supplies coarse city/region/country', () => {
		const tags: RawParts = {
			street: '1265 Lawrence Ave W',
			city: null,
			region: null,
			postcode: null,
			country: null
		};
		const nom: RawParts = {
			street: 'Lawrence Avenue West',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M6L 9Z9',
			country: 'ca'
		};
		const existing: RawParts = {
			street: '1265 Lawrence Ave W',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M6L 1A4',
			country: null
		};
		expect(chooseParts(tags, nom, existing)).toEqual({
			street: '1265 Lawrence Ave W',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M6L 1A4', // the venue's own postcode, not Nominatim's interpolation
			country: 'ca'
		});
	});

	test('Nominatim fills a missing postcode and a bilingual region via ISO code', () => {
		const nom: RawParts = {
			street: 'Chemin Madawaska',
			city: 'Grand-Sault',
			region: 'NB',
			postcode: 'E3Y 1A3',
			country: 'ca'
		};
		const existing: RawParts = {
			street: '478 Madawaska Rd',
			city: null,
			region: null,
			postcode: null,
			country: null
		};
		expect(chooseParts(EMPTY, nom, existing)).toMatchObject({
			street: '478 Madawaska Rd',
			region: 'NB',
			postcode: 'E3Y 1A3'
		});
	});

	test('skips a partial own-postcode in favour of a full one from Nominatim', () => {
		const tags: RawParts = {
			street: '8730 156 St',
			city: 'Edmonton',
			region: 'AB',
			postcode: 'T5R',
			country: null
		};
		const nom: RawParts = {
			street: '156 Street NW',
			city: 'Edmonton',
			region: 'AB',
			postcode: 'T5R 1R8',
			country: 'ca'
		};
		expect(chooseParts(tags, nom, EMPTY).postcode).toBe('T5R 1R8');
	});
});

describe('normalizeParts', () => {
	test('normalizes a full address and infers country from region', () => {
		const r = normalizeParts({
			street: '1909 W 4th Ave',
			city: 'Vancouver',
			region: 'British Columbia',
			postcode: 'v6j1m5',
			country: null
		});
		expect(r).toMatchObject({
			street: '1909 W 4th Ave',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
			missingRequired: [],
			postcodeMissing: false
		});
	});

	test('flags missing required fields and a missing postcode', () => {
		const r = normalizeParts({
			street: '100 Bayshore Dr',
			city: null,
			region: 'ON',
			postcode: null,
			country: 'ca'
		});
		expect(r.missingRequired).toEqual(['city']);
		expect(r.postcodeMissing).toBe(true);
		expect(r.country).toBe('CA');
	});

	test('drops a partial postcode rather than storing half a code', () => {
		const r = normalizeParts({
			street: '8730 156 St',
			city: 'Edmonton',
			region: 'AB',
			postcode: 'T5R',
			country: 'CA'
		});
		expect(r.postcode).toBeNull();
		expect(r.postcodeMissing).toBe(true);
		expect(r.missingRequired).toEqual([]);
	});
});
