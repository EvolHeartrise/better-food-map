import { expect, test, describe } from 'bun:test';
import {
	formatAddress,
	normalizeRegion,
	normalizePostcode,
	normalizeCountry,
	composeStreet
} from '../src/lib/address';

describe('formatAddress', () => {
	test('joins street, city, region + postcode', () => {
		expect(
			formatAddress({
				street: '1909 W 4th Ave',
				city: 'Vancouver',
				region: 'BC',
				postcode: 'V6J 1M5'
			})
		).toBe('1909 W 4th Ave, Vancouver, BC V6J 1M5');
	});

	test('omits postcode when null', () => {
		expect(
			formatAddress({ street: '100 Bayshore Dr', city: 'Ottawa', region: 'ON', postcode: null })
		).toBe('100 Bayshore Dr, Ottawa, ON');
	});

	test('trims and drops blank parts defensively', () => {
		expect(
			formatAddress({
				street: '  5 Main St ',
				city: 'Hope',
				region: 'BC',
				postcode: '' as unknown as null
			})
		).toBe('5 Main St, Hope, BC');
	});
});

describe('normalizeRegion', () => {
	test('passes through a valid code regardless of case', () => {
		expect(normalizeRegion('bc', 'CA')).toBe('BC');
		expect(normalizeRegion('ON')).toBe('ON');
	});

	test('maps full Canadian names to codes', () => {
		expect(normalizeRegion('Ontario', 'CA')).toBe('ON');
		expect(normalizeRegion('British Columbia')).toBe('BC');
		expect(normalizeRegion('Québec', 'CA')).toBe('QC');
		expect(normalizeRegion('Newfoundland and Labrador', 'CA')).toBe('NL');
	});

	test('folds ampersands, dotted abbreviations and PEI', () => {
		expect(normalizeRegion('Newfoundland & Labrador', 'CA')).toBe('NL');
		expect(normalizeRegion('PEI', 'CA')).toBe('PE');
		expect(normalizeRegion('P.E.I.')).toBe('PE');
		expect(normalizeRegion('pei')).toBe('PE');
	});

	test('resolves bilingual OSM boundary labels', () => {
		expect(normalizeRegion('New Brunswick / Nouveau-Brunswick', 'CA')).toBe('NB');
		expect(normalizeRegion('ᓄᓇᕗᑦ Nunavut', 'CA')).toBe('NU');
		expect(normalizeRegion('Yukon / Le Yukon')).toBe('YT');
	});

	test('maps full US state names to codes', () => {
		expect(normalizeRegion('Washington', 'US')).toBe('WA');
		expect(normalizeRegion('New York')).toBe('NY');
	});

	test('rejects a code that is not valid for the stated country', () => {
		expect(normalizeRegion('XX', 'CA')).toBeNull();
		expect(normalizeRegion('BC', 'US')).toBeNull();
	});

	test('returns null for unknown / empty input', () => {
		expect(normalizeRegion('Atlantis')).toBeNull();
		expect(normalizeRegion('')).toBeNull();
		expect(normalizeRegion(null)).toBeNull();
	});
});

describe('normalizePostcode', () => {
	test('canonicalizes Canadian postcodes to A1A 1A1', () => {
		expect(normalizePostcode('v6j1m5', 'CA')).toBe('V6J 1M5');
		expect(normalizePostcode('R2G 1N3')).toBe('R2G 1N3');
		expect(normalizePostcode('R2G1N3')).toBe('R2G 1N3');
	});

	test('rejects a partial Canadian code (bare FSA)', () => {
		expect(normalizePostcode('T5R', 'CA')).toBeNull();
		expect(normalizePostcode('T5R')).toBeNull();
	});

	test('keeps US ZIP and ZIP+4', () => {
		expect(normalizePostcode('98101', 'US')).toBe('98101');
		expect(normalizePostcode('98101-1234', 'US')).toBe('98101-1234');
	});

	test('returns null for empty / nonsense', () => {
		expect(normalizePostcode('', 'CA')).toBeNull();
		expect(normalizePostcode(null)).toBeNull();
		expect(normalizePostcode('not-a-code', 'CA')).toBeNull();
	});
});

describe('normalizeCountry', () => {
	test('maps names and codes to ISO-2', () => {
		expect(normalizeCountry('Canada')).toBe('CA');
		expect(normalizeCountry('ca')).toBe('CA');
		expect(normalizeCountry('United States')).toBe('US');
		expect(normalizeCountry('usa')).toBe('US');
	});

	test('trusts an unknown 2-letter code, uppercased', () => {
		expect(normalizeCountry('de')).toBe('DE');
	});

	test('returns null for unknown names', () => {
		expect(normalizeCountry('Narnia')).toBeNull();
		expect(normalizeCountry(null)).toBeNull();
	});
});

describe('composeStreet', () => {
	test('joins house number and street', () => {
		expect(composeStreet('1909', 'W 4th Ave')).toBe('1909 W 4th Ave');
	});

	test('renders a unit in Canadian hyphen style with a house number', () => {
		expect(composeStreet('6485', '120 St', '100')).toBe('100-6485 120 St');
	});

	test('appends a unit plainly when there is no house number', () => {
		expect(composeStreet(null, 'Main St', '3')).toBe('Main St, Unit 3');
	});

	test('returns null without a street name', () => {
		expect(composeStreet('100', null)).toBeNull();
		expect(composeStreet('100', '   ')).toBeNull();
	});
});
