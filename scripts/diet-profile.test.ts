import { expect, test, describe } from 'bun:test';
import { DIET_OPTIONS, DIET_IDS, sanitizeDiet } from '../src/lib/diet-profile';

// The curated dietary tag ids the map's TAGS vocabulary defines. Every diet option
// must map to one of these, or the selector would filter on a tag no item can carry.
// Mirrored here (rather than imported from the server-only db module) to keep this
// test client-safe.
const DIETARY_TAG_IDS = new Set([
	'vegan',
	'vegetarian',
	'gluten_free',
	'dairy_free',
	'nut_free',
	'halal'
]);

describe('catalog integrity', () => {
	test('every diet option maps to a real dietary tag', () => {
		for (const option of DIET_OPTIONS) {
			expect(DIETARY_TAG_IDS.has(option.id)).toBe(true);
		}
	});

	test('options cover exactly the dietary tag vocabulary', () => {
		expect(new Set(DIET_OPTIONS.map((o) => o.id))).toEqual(DIETARY_TAG_IDS);
	});

	test('ids are unique and DIET_IDS mirrors the options', () => {
		expect(DIET_IDS.size).toBe(DIET_OPTIONS.length);
		for (const option of DIET_OPTIONS) expect(DIET_IDS.has(option.id)).toBe(true);
	});

	test('every option has a non-empty label', () => {
		for (const option of DIET_OPTIONS) expect(option.label.length).toBeGreaterThan(0);
	});
});

describe('sanitizeDiet', () => {
	test('passes through a valid diet id', () => {
		expect(sanitizeDiet('vegan')).toBe('vegan');
		expect(sanitizeDiet('gluten_free')).toBe('gluten_free');
	});

	test('maps null/undefined to null', () => {
		expect(sanitizeDiet(null)).toBeNull();
		expect(sanitizeDiet(undefined)).toBeNull();
	});

	test('rejects unknown or non-dietary ids', () => {
		expect(sanitizeDiet('bogus')).toBeNull();
		// Course tags are not selectable diets.
		expect(sanitizeDiet('dessert')).toBeNull();
		expect(sanitizeDiet('')).toBeNull();
	});
});
