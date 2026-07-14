import { expect, test, describe } from 'bun:test';
import { DIET_OPTIONS, DIET_IDS, sanitizeDiet } from '../src/lib/diet-profile';
import { TAGS } from '../src/lib/tags';

describe('catalog integrity', () => {
	test('options cover exactly the dietary tag vocabulary, with its display names', () => {
		// DIET_OPTIONS is derived from TAGS, so this is a sanity check on the
		// derivation (dietary-only, id + name carried through), not a hand-sync.
		expect(DIET_OPTIONS).toEqual(
			TAGS.filter((t) => t.tag_type === 'dietary').map((t) => ({ id: t.id, label: t.name }))
		);
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
		expect(sanitizeDiet('gluten_friendly')).toBe('gluten_friendly');
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

	test('collapses forged filter values to null (getMapCells cache-key guard)', () => {
		// getMapCells' schema only length-caps `diet`; the handler relies on
		// sanitizeDiet to keep forged values out of the shared colo block-cache
		// key and out of the SQL filter (the cache assumes 6-value cardinality).
		expect(sanitizeDiet('x'.repeat(64))).toBeNull();
		expect(sanitizeDiet('VEGAN')).toBeNull(); // ids are exact, lowercase tokens
		expect(sanitizeDiet("vegan' OR 1=1")).toBeNull();
	});
});
