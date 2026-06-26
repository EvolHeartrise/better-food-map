/// <reference types="bun-types" />
// Exercises the ingredient canonicalization layer (migration 0010 +
// db.ts ingredientLinkStmts + searchTagVocabulary + $lib/tags helpers):
//   * accent folding on the write path (deterministic, rule-safe),
//   * the `ingredient_aliases` map redirecting a variant to its canonical tag on
//     BOTH write (no duplicate row) and read (the picker finds it),
//   * the prose-warning heuristic.
// Runs against the real migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	searchTagVocabulary,
	getItemById,
	insertLocations,
	insertFoods,
	type D1Like
} from '../src/lib/server/db';
import { foldIngredientName, ingredientProseWarning } from '../src/lib/tags';
import { freshDb } from './test-d1';

async function seedCafe(db: D1Like): Promise<string> {
	const [id] = await insertLocations(db, [
		{
			name: 'Indie Cafe',
			category: 'cafe',
			latitude: 49.2,
			longitude: -123.1,
			street: '1 Test St',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
			phone: null,
			website: null
		}
	]);
	return id;
}

/** Distinct ingredient tag ids linked to an item, for asserting canonicalization. */
async function ingredientTagIds(db: D1Like, itemId: string): Promise<string[]> {
	const item = await getItemById(db, itemId);
	return (item?.tags ?? [])
		.filter((t) => t.tag_type === 'ingredient')
		.map((t) => t.id)
		.toSorted();
}

test('foldIngredientName strips accents, lower-cases and collapses whitespace', () => {
	expect(foldIngredientName('Jalapeño')).toBe('jalapeno');
	expect(foldIngredientName('  Crème   Fraîche ')).toBe('creme fraiche');
	expect(foldIngredientName('TOMATO')).toBe('tomato');
});

test('accents are folded on write, so accented and plain spellings share one tag', async () => {
	const db = freshDb();
	const cafe = await seedCafe(db);
	const [a, b] = await insertFoods(db, [
		{ location_id: cafe, item_name: 'Nachos', ingredients: 'Jalapeño', price: 9 },
		{ location_id: cafe, item_name: 'Tacos', ingredients: 'jalapeno', price: 10 }
	]);
	expect(await ingredientTagIds(db, a)).toEqual(['ing:jalapeno']);
	expect(await ingredientTagIds(db, b)).toEqual(['ing:jalapeno']);
});

test('a variant alias redirects to the canonical tag on write (no duplicate tag row)', async () => {
	const db = freshDb();
	const cafe = await seedCafe(db);
	// Canonical tomato exists; "tomatoes" is registered as its alias.
	await insertFoods(db, [
		{ location_id: cafe, item_name: 'Caprese', ingredients: 'tomato', price: 8 }
	]);
	await db
		.prepare(
			`INSERT INTO ingredient_aliases (alias, canonical_id, source) VALUES ('tomatoes', 'ing:tomato', 'plural')`
		)
		.run();

	const [bruschetta] = await insertFoods(db, [
		{ location_id: cafe, item_name: 'Bruschetta', ingredients: 'Tomatoes', price: 7 }
	]);
	// Linked to the CANONICAL tag, not a new ing:tomatoes row.
	expect(await ingredientTagIds(db, bruschetta)).toEqual(['ing:tomato']);
	const { results } = await db
		.prepare(`SELECT id FROM tags WHERE id = 'ing:tomatoes'`)
		.all<{ id: string }>();
	expect(results).toHaveLength(0);
});

test('searching a variant spelling returns the canonical tag (read side of the map)', async () => {
	const db = freshDb();
	const cafe = await seedCafe(db);
	await insertFoods(db, [
		{ location_id: cafe, item_name: 'Curry', ingredients: 'chickpea', price: 12 }
	]);
	await db
		.prepare(
			`INSERT INTO ingredient_aliases (alias, canonical_id, source) VALUES ('garbanzo', 'ing:chickpea', 'synonym')`
		)
		.run();

	// The user types the synonym; the picker surfaces the canonical tag.
	const hits = await searchTagVocabulary(db, 'garbanzo');
	expect(hits.map((t) => t.id)).toContain('ing:chickpea');
	// And the canonical name still matches directly.
	expect((await searchTagVocabulary(db, 'chickpea')).map((t) => t.id)).toContain('ing:chickpea');
});

test('an accented query matches the accent-folded canonical tag (no alias row needed)', async () => {
	const db = freshDb();
	const cafe = await seedCafe(db);
	// Stored folded as ing:jalapeno on write.
	await insertFoods(db, [
		{ location_id: cafe, item_name: 'Nachos', ingredients: 'Jalapeño', price: 9 }
	]);
	// The user types the accented form; folding the query makes it match.
	expect((await searchTagVocabulary(db, 'jalapeño')).map((t) => t.id)).toContain('ing:jalapeno');
});

test('ingredientProseWarning flags descriptions/prices but passes real ingredients', () => {
	// Clean component nouns — no warning.
	expect(ingredientProseWarning('tomato')).toBeNull();
	expect(ingredientProseWarning('extra virgin olive oil')).toBeNull();
	expect(ingredientProseWarning('san marzano tomato')).toBeNull();
	// Prose / prices / serving notes — warned.
	expect(ingredientProseWarning('served with sambar and coconut chutney')).not.toBeNull();
	expect(ingredientProseWarning('12 oz coffee')).not.toBeNull();
	expect(ingredientProseWarning('deep-fried doughnuts (bhatura)')).not.toBeNull();
	expect(
		ingredientProseWarning('a side of maple syrup and fresh fruit slices and so much more here')
	).not.toBeNull();
});

test('ingredientProseWarning flags prep/cut/sourcing qualifiers down to the base noun', () => {
	// Cooking-method qualifiers — fold to the base ingredient.
	expect(ingredientProseWarning('grilled chicken')).not.toBeNull();
	expect(ingredientProseWarning('deep fried chicken')).not.toBeNull();
	expect(ingredientProseWarning('steamed milk')).not.toBeNull();
	expect(ingredientProseWarning('tandoor-baked')).not.toBeNull();
	// Cut/form qualifiers.
	expect(ingredientProseWarning('whole chicken')).not.toBeNull();
	expect(ingredientProseWarning('ground beef')).not.toBeNull();
	expect(ingredientProseWarning('diced tomato')).not.toBeNull();
	// Sourcing / freshness qualifiers.
	expect(ingredientProseWarning('house fries')).not.toBeNull();
	expect(ingredientProseWarning('fresh herbs')).not.toBeNull();
});

test('ingredientProseWarning flags conjunctions, slashes and process clauses', () => {
	expect(ingredientProseWarning('chopped almonds and pistachios')).not.toBeNull();
	expect(ingredientProseWarning('kale & spinach')).not.toBeNull();
	expect(ingredientProseWarning('lettuce/greens')).not.toBeNull();
	expect(ingredientProseWarning('steamed then fried')).not.toBeNull();
	expect(ingredientProseWarning('baked in the tandoor')).not.toBeNull();
	expect(ingredientProseWarning('lamb braised in yogurt')).not.toBeNull();
});

test('ingredientProseWarning leaves transformation preps and idiomatic compounds clean', () => {
	// Transformation-defining preps yield a distinct product — kept (see fold/keep policy).
	for (const keep of [
		'smoked paprika',
		'smoked salmon',
		'pickled onion',
		'dried mint',
		'fermented black bean',
		'whipped cream',
		'marinated tofu',
		'breaded chicken'
	]) {
		expect(ingredientProseWarning(keep)).toBeNull();
	}
	// Idioms and genuine compound ingredients whose first word is part of the identity.
	for (const keep of [
		'hot sauce',
		'cold brew',
		'soy sauce',
		'fish sauce',
		'coconut milk',
		'oat milk',
		'whole wheat flour',
		'whole milk',
		'green onion',
		'bell pepper',
		'brown sugar'
	]) {
		expect(ingredientProseWarning(keep)).toBeNull();
	}
});
