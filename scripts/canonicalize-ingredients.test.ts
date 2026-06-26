/// <reference types="bun-types" />
// Exercises the ingredient-vocabulary cleanup (scripts/canonicalize-ingredients):
// the pure edge derivation / transitive resolution, and an end-to-end merge against
// the real migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import { deriveEdges, resolveCanonical } from './canonicalize-ingredients';
import {
	searchTagVocabulary,
	insertLocations,
	insertFoods,
	type D1Like
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('deriveEdges maps plurals (both-exist), diacritics and synonyms', () => {
	const edges = deriveEdges([
		'tomato',
		'tomatoes',
		'jalapeño',
		'chickpea',
		'garbanzo',
		'molasses', // singular "molasse" absent → must NOT be touched
		'onion'
	]);
	expect(edges.get('tomatoes')).toBe('tomato'); // plural → singular (both present)
	expect(edges.get('jalapeño')).toBe('jalapeno'); // diacritic fold
	expect(edges.get('garbanzo')).toBe('chickpea'); // synonym
	expect(edges.has('molasses')).toBe(false); // no invented singular
	expect(edges.has('onion')).toBe(false); // singular with no plural present
});

test('resolveCanonical collapses chains to the terminal canonical', () => {
	const edges = new Map([
		['jalapeños', 'jalapenos'],
		['jalapenos', 'jalapeno']
	]);
	const resolved = resolveCanonical(edges);
	expect(resolved.get('jalapeños')).toBe('jalapeno');
	expect(resolved.get('jalapenos')).toBe('jalapeno');
});

test('resolveCanonical drops cycles defensively', () => {
	const edges = new Map([
		['a', 'b'],
		['b', 'a']
	]);
	expect(resolveCanonical(edges).size).toBe(0);
});

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

test('merge collapses a plural tag into its singular, registers the alias, repoints items', async () => {
	const db = freshDb();
	const cafe = await seedCafe(db);
	// Two items: one uses the singular, one the plural — currently two distinct tags.
	await insertFoods(db, [
		{ location_id: cafe, item_name: 'Caprese', ingredients: 'tomato', price: 8 },
		{ location_id: cafe, item_name: 'Bruschetta', ingredients: 'tomatoes', price: 7 }
	]);
	const before = await db
		.prepare(`SELECT id FROM tags WHERE id IN ('ing:tomato','ing:tomatoes') ORDER BY id`)
		.all<{ id: string }>();
	expect(before.results.map((r) => r.id)).toEqual(['ing:tomato', 'ing:tomatoes']);

	// The script's derivation agrees this plural maps to the singular.
	const { results: names } = await db
		.prepare(`SELECT name FROM tags WHERE tag_type='ingredient'`)
		.all<{ name: string }>();
	const resolved = resolveCanonical(deriveEdges(names.map((n) => n.name)));
	expect(resolved.get('tomatoes')).toBe('tomato');

	// Manually run the merge statements (the script's mergeStatements is module-private;
	// reproduce the same effect here to assert the schema-level outcome).
	await db.batch([
		db.prepare(
			`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
				 SELECT item_id, 'ing:tomato', optional FROM item_tags WHERE tag_id='ing:tomatoes'`
		),
		db.prepare(`DELETE FROM item_tags WHERE tag_id='ing:tomatoes'`),
		db.prepare(
			`INSERT OR IGNORE INTO ingredient_aliases (alias, canonical_id, source) VALUES ('tomatoes','ing:tomato','plural')`
		),
		db.prepare(`DELETE FROM tags WHERE id='ing:tomatoes'`)
	]);

	// The plural tag is gone; both items now resolve to the canonical via search.
	const after = await db
		.prepare(`SELECT id FROM tags WHERE id='ing:tomatoes'`)
		.all<{ id: string }>();
	expect(after.results).toHaveLength(0);
	const links = await db
		.prepare(`SELECT COUNT(*) AS n FROM item_tags WHERE tag_id='ing:tomato'`)
		.first<{ n: number }>();
	expect(links?.n).toBe(2);
	// Searching the (now-merged-away) plural still surfaces the canonical, via the alias.
	expect((await searchTagVocabulary(db, 'tomatoes')).map((t) => t.id)).toContain('ing:tomato');
});
