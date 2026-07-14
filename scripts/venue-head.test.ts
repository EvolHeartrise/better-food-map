// Pins the venue SEO head copy (src/lib/venue-head.ts) — the title/description a
// crawler or link unfurler sees on a hard /locations/<id> load. Issue #222: the
// title must lead with the city, and the description must surface the menu's
// dietary coverage. Both are load-bearing for search ranking, so the exact
// strings are asserted here rather than left to eyeball on the rendered page.
import { expect, test, describe } from 'bun:test';
import {
	venueHeadMeta,
	dietaryCoverageClause,
	CANONICAL_ORIGIN,
	type HeadVenue
} from '../src/lib/venue-head';

/** A venue whose menu carries `tags` (dietary tag ids) on each item. */
function venue(overrides: Partial<HeadVenue> = {}): HeadVenue {
	return {
		id: 'joes-diner',
		name: "Joe's Diner",
		category: 'restaurant',
		city: 'Guelph',
		region: 'ON',
		menu: [],
		...overrides
	};
}

/** N menu items each tagged with every id in `tagIds`. */
function items(count: number, ...tagIds: string[]): HeadVenue['menu'] {
	return Array.from({ length: count }, () => ({ tags: tagIds.map((id) => ({ id })) }));
}

describe('venueHeadMeta title', () => {
	test('leads with the venue name then city and region', () => {
		expect(venueHeadMeta(venue()).title).toBe("Joe's Diner – Guelph, ON | BetterFoodMaps");
	});

	test('drops the location clause when city and region are both blank', () => {
		expect(venueHeadMeta(venue({ city: '', region: '' })).title).toBe(
			"Joe's Diner | BetterFoodMaps"
		);
	});

	test('keeps whichever location part is present', () => {
		expect(venueHeadMeta(venue({ region: '' })).title).toBe(
			"Joe's Diner – Guelph | BetterFoodMaps"
		);
	});
});

describe('venueHeadMeta description', () => {
	test('opens with name, category and place, then dietary coverage', () => {
		const meta = venueHeadMeta(
			venue({ menu: [...items(12, 'vegan'), ...items(8, 'gluten_friendly')] })
		);
		expect(meta.description).toBe(
			"Joe's Diner, restaurant in Guelph, ON. 12 vegan and 8 gluten-friendly menu items on BetterFoodMaps."
		);
	});

	test('falls back to a plain item count when no item is dietary-tagged', () => {
		const meta = venueHeadMeta(venue({ menu: items(5, 'food') }));
		expect(meta.description).toBe(
			"Joe's Diner, restaurant in Guelph, ON. 5 menu items on BetterFoodMaps."
		);
	});

	test('handles an empty menu', () => {
		expect(venueHeadMeta(venue({ menu: [] })).description).toBe(
			"Joe's Diner, restaurant in Guelph, ON. See the menu on BetterFoodMaps."
		);
	});

	test('omits the category when the venue has none', () => {
		expect(venueHeadMeta(venue({ category: null, menu: items(3, 'vegan') })).description).toBe(
			"Joe's Diner in Guelph, ON. 3 vegan menu items on BetterFoodMaps."
		);
	});

	test('lower-cases the multi-word category label', () => {
		expect(
			venueHeadMeta(venue({ category: 'fast_food', menu: items(2, 'halal') })).description
		).toBe("Joe's Diner, fast food in Guelph, ON. 2 halal menu items on BetterFoodMaps.");
	});
});

describe('venueHeadMeta url', () => {
	test('is the canonical descriptive slug for a UUID id (issue #221)', () => {
		expect(
			venueHeadMeta(
				venue({ id: '9f0e8d7c-6b5a-4321-8765-4321fedcba98', name: 'Prado Café', city: 'Vancouver' })
			).url
		).toBe(
			`${CANONICAL_ORIGIN}/locations/prado-cafe-vancouver-9f0e8d7c-6b5a-4321-8765-4321fedcba98`
		);
	});

	test('is the canonical origin plus the encoded bare id for a legacy short-slug id', () => {
		expect(venueHeadMeta(venue({ id: 'a b/c' })).url).toBe(
			`${CANONICAL_ORIGIN}/locations/a%20b%2Fc`
		);
	});
});

describe('dietaryCoverageClause', () => {
	test('is null when nothing is dietary-tagged (course tags do not count)', () => {
		expect(dietaryCoverageClause(items(4, 'food', 'dessert'))).toBeNull();
		expect(dietaryCoverageClause([])).toBeNull();
	});

	test('orders diets by coverage, strongest first', () => {
		const menu = [...items(3, 'vegan'), ...items(9, 'gluten_friendly'), ...items(5, 'halal')];
		expect(dietaryCoverageClause(menu)).toBe('9 gluten-friendly, 5 halal and 3 vegan menu items');
	});

	test('lists at most the top three diets', () => {
		const menu = [
			...items(6, 'vegan'),
			...items(5, 'vegetarian'),
			...items(4, 'gluten_friendly'),
			...items(3, 'dairy_free'),
			...items(2, 'nut_free')
		];
		expect(dietaryCoverageClause(menu)).toBe(
			'6 vegan, 5 vegetarian and 4 gluten-friendly menu items'
		);
	});

	test('does not apply the vegan⊃vegetarian implication — counts explicit tags only', () => {
		// A purely-vegan menu (vegetarian/dairy-free stripped at write time) reads
		// as vegan only, keeping the distinct axes the description is meant to show.
		expect(dietaryCoverageClause(items(10, 'vegan'))).toBe('10 vegan menu items');
	});

	test('breaks count ties by display order (vegan before gluten-friendly)', () => {
		expect(dietaryCoverageClause([...items(4, 'gluten_friendly'), ...items(4, 'vegan')])).toBe(
			'4 vegan and 4 gluten-friendly menu items'
		);
	});

	test('uses the singular noun for a lone count of one', () => {
		expect(dietaryCoverageClause(items(1, 'vegan'))).toBe('1 vegan menu item');
	});

	test('counts an item once per diet even with multiple dietary tags', () => {
		expect(dietaryCoverageClause(items(3, 'vegan', 'gluten_friendly'))).toBe(
			'3 vegan and 3 gluten-friendly menu items'
		);
	});
});
