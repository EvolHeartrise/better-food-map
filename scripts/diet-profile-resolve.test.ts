/// <reference types="bun-types" />
// Exercises the SERVER side of the dietary-profile feature against the real
// migration schema via the in-memory D1Like adapter:
//   • resolveDietProfileFilters — turns a profile's include tag ids + exclude
//     ingredient names into concrete Tag objects, resolving ingredient names the
//     same alias-/accent-aware way the write path and tag search do.
//   • getDietProfile / setDietProfile — the per-user upsert round-trip.
// The pure key→filter mapping is covered separately in diet-profile.test.ts.

import { test, expect } from 'bun:test';
import {
	resolveDietProfileFilters,
	getDietProfile,
	setDietProfile,
	insertLocations,
	insertFoods
} from '../src/lib/server/db';
import { freshDb, type TestD1 } from './test-d1';

/** Seeds a venue with menu items so their ingredient tags (ing:<name>) exist. */
async function seedIngredients(db: TestD1, ingredients: string): Promise<void> {
	const [locId] = await insertLocations(db, [
		{
			name: 'Test Kitchen',
			category: 'restaurant',
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
	await insertFoods(db, [{ location_id: locId, item_name: 'Test Dish', ingredients, price: 10 }]);
}

test('resolveDietProfileFilters: include maps curated tags, drops unknown ids', async () => {
	const db = freshDb();
	const { included, excluded } = await resolveDietProfileFilters(
		db,
		['vegan', 'nut_free', 'not_a_tag'],
		[]
	);
	expect(included.map((t) => t.id)).toEqual(['vegan', 'nut_free']);
	expect(included.every((t) => t.tag_type === 'dietary')).toBe(true);
	expect(excluded).toEqual([]);
});

test('resolveDietProfileFilters: exclude resolves existing ingredient tags only', async () => {
	const db = freshDb();
	await seedIngredients(db, 'peanut, milk, tomato');
	const { excluded } = await resolveDietProfileFilters(db, [], ['peanut', 'milk', 'unicorn dust']);
	const ids = excluded.map((t) => t.id).toSorted();
	// peanut + milk exist as ingredient tags; "unicorn dust" matches nothing and is dropped.
	expect(ids).toEqual(['ing:milk', 'ing:peanut']);
	expect(excluded.every((t) => t.tag_type === 'ingredient')).toBe(true);
});

test('resolveDietProfileFilters: exclude folds accents and follows aliases', async () => {
	const db = freshDb();
	await seedIngredients(db, 'jalapeño, tomato');
	// A plural alias pointing at the canonical tomato tag (as the seed script writes).
	await db
		.prepare(`INSERT INTO ingredient_aliases (alias, canonical_id, source) VALUES (?, ?, 'plural')`)
		.bind('tomatoes', 'ing:tomato')
		.run();
	// "Jalapeño" folds to ing:jalapeno; "tomatoes" resolves to ing:tomato via the alias.
	const { excluded } = await resolveDietProfileFilters(db, [], ['Jalapeño', 'tomatoes']);
	expect(excluded.map((t) => t.id).toSorted()).toEqual(['ing:jalapeno', 'ing:tomato']);
});

test('resolveDietProfileFilters: de-duplicates a tag matched by both id and alias', async () => {
	const db = freshDb();
	await seedIngredients(db, 'tomato');
	await db
		.prepare(`INSERT INTO ingredient_aliases (alias, canonical_id, source) VALUES (?, ?, 'plural')`)
		.bind('tomatoes', 'ing:tomato')
		.run();
	// Both the canonical name and its alias point at the same tag — it appears once.
	const { excluded } = await resolveDietProfileFilters(db, [], ['tomato', 'tomatoes']);
	expect(excluded.map((t) => t.id)).toEqual(['ing:tomato']);
});

test('getDietProfile / setDietProfile: round-trips and upserts per user', async () => {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();

	// No row yet → empty profile.
	expect(await getDietProfile(db, 'u1')).toEqual({ restrictions: [], allergies: [] });

	await setDietProfile(db, 'u1', { restrictions: ['vegan'], allergies: ['nuts', 'dairy'] }, 1000);
	expect(await getDietProfile(db, 'u1')).toEqual({
		restrictions: ['vegan'],
		allergies: ['nuts', 'dairy']
	});

	// A second save for the same user overwrites (upsert), not duplicates.
	await setDietProfile(db, 'u1', { restrictions: ['halal'], allergies: [] }, 2000);
	expect(await getDietProfile(db, 'u1')).toEqual({ restrictions: ['halal'], allergies: [] });
	const { results } = await db
		.prepare(`SELECT COUNT(*) AS n FROM user_dietary_profile WHERE user_id = 'u1'`)
		.all<{ n: number }>();
	expect(results[0].n).toBe(1);
});
