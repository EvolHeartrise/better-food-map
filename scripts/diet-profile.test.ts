import { expect, test, describe } from 'bun:test';
import {
	DIETARY_RESTRICTIONS,
	ALLERGENS,
	RESTRICTION_KEYS,
	ALLERGEN_KEYS,
	sanitizeProfile,
	profileIncludeTagIds,
	profileExcludeIngredientNames,
	isEmptyProfile,
	EMPTY_DIET_PROFILE
} from '../src/lib/diet-profile';

// The curated dietary tag ids the map's TAGS vocabulary defines. The catalog's
// `tag` references must stay a subset of these, or a profile would try to include a
// tag the picker can't render. Mirrored here (rather than imported from the
// server-only db module) to keep this test client-safe.
const DIETARY_TAG_IDS = new Set([
	'vegan',
	'vegetarian',
	'gluten_free',
	'dairy_free',
	'nut_free',
	'halal'
]);

describe('catalog integrity', () => {
	test('every restriction maps to a real dietary tag', () => {
		for (const r of DIETARY_RESTRICTIONS) {
			expect(DIETARY_TAG_IDS.has(r.tag)).toBe(true);
		}
	});

	test('allergen "-free" tags (when present) are real dietary tags', () => {
		for (const a of ALLERGENS) {
			if (a.tag !== undefined) expect(DIETARY_TAG_IDS.has(a.tag)).toBe(true);
		}
	});

	test('allergens always name at least one ingredient to exclude', () => {
		for (const a of ALLERGENS) {
			expect(a.ingredients.length).toBeGreaterThan(0);
		}
	});

	test('keys are unique within each catalog', () => {
		expect(RESTRICTION_KEYS.size).toBe(DIETARY_RESTRICTIONS.length);
		expect(ALLERGEN_KEYS.size).toBe(ALLERGENS.length);
	});
});

describe('profileIncludeTagIds', () => {
	test('includes a restriction tag', () => {
		expect(profileIncludeTagIds({ restrictions: ['vegan'], allergies: [] })).toEqual(['vegan']);
	});

	test('includes an allergen "-free" tag', () => {
		expect(profileIncludeTagIds({ restrictions: [], allergies: ['nuts'] })).toEqual(['nut_free']);
	});

	test('omits a tag for an allergen with no "-free" tag (egg)', () => {
		expect(profileIncludeTagIds({ restrictions: [], allergies: ['egg'] })).toEqual([]);
	});

	test('de-duplicates and ignores unknown keys', () => {
		const ids = profileIncludeTagIds({
			restrictions: ['vegan', 'vegan', 'bogus'],
			allergies: ['gluten']
		});
		expect(ids.toSorted()).toEqual(['gluten_free', 'vegan']);
	});
});

describe('profileExcludeIngredientNames', () => {
	test('returns the selected allergen ingredient list', () => {
		const names = profileExcludeIngredientNames({ restrictions: [], allergies: ['nuts'] });
		expect(names).toContain('peanut');
		expect(names).toContain('almond');
	});

	test('unions and de-duplicates across allergens', () => {
		const names = profileExcludeIngredientNames({ restrictions: [], allergies: ['soy', 'sesame'] });
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain('tofu');
		expect(names).toContain('tahini');
	});

	test('restrictions contribute no exclusions', () => {
		expect(profileExcludeIngredientNames({ restrictions: ['vegan'], allergies: [] })).toEqual([]);
	});
});

describe('sanitizeProfile', () => {
	test('drops unknown keys and de-duplicates', () => {
		expect(
			sanitizeProfile({
				restrictions: ['vegan', 'vegan', 'nope'],
				allergies: ['nuts', 'also-nope', 'nuts']
			})
		).toEqual({ restrictions: ['vegan'], allergies: ['nuts'] });
	});
});

describe('isEmptyProfile', () => {
	test('true for the empty profile', () => {
		expect(isEmptyProfile(EMPTY_DIET_PROFILE)).toBe(true);
	});

	test('false when anything is selected', () => {
		expect(isEmptyProfile({ restrictions: [], allergies: ['egg'] })).toBe(false);
	});
});
