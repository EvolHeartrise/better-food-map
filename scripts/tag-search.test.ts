/// <reference types="bun-types" />
// Exercises searchTagVocabulary (the read behind the `searchTags` remote that
// backs the tag filter's searchable picker). It searches the WHOLE tag
// vocabulary — the curated dietary/course tags plus the `ingredient` tags
// created from item data — by name substring, ranked and capped. The substring
// match runs against the `tags_fts` trigram index (migration 0006), kept in sync
// with `tags` by triggers; this test runs against that real schema via the
// in-memory D1Like adapter, so it also covers the trigram tokenizer and the
// insert trigger.

import { test, expect } from 'bun:test';
import { searchTagVocabulary, insertLocations, insertFoods } from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('empty query returns the curated dietary/course tags', async () => {
	const db = freshDb();
	const tags = await searchTagVocabulary(db, '');
	expect(tags.map((t) => t.id)).toEqual([
		'vegan',
		'vegetarian',
		'gluten_free',
		'dairy_free',
		'nut_free',
		'halal',
		'dessert',
		'drink'
	]);
});

test('a query matches curated tags by substring, ranked prefix-first', async () => {
	const db = freshDb();
	// "veg" prefixes Vegan and Vegetarian; both are curated dietary tags.
	const tags = await searchTagVocabulary(db, 'veg');
	expect(tags.map((t) => t.id)).toEqual(['vegan', 'vegetarian']);
});

test('ingredient tags become searchable, and rank after a curated exact match', async () => {
	const db = freshDb();
	const [cafeId] = await insertLocations(db, [
		{
			name: 'Indie Cafe',
			category: 'cafe',
			latitude: 49.2,
			longitude: -123.1,
			address: '1 Test St',
			phone: null,
			website: null
		}
	]);
	// Inserting items with ingredients creates `ingredient` tags via INSERT OR
	// IGNORE INTO tags — which must fire the tags_fts sync trigger.
	await insertFoods(db, [
		{
			location_id: cafeId,
			item_name: 'Cheese Board',
			ingredients: 'Cheese, Blue cheese, Goat cheese',
			price: 14
		}
	]);

	const tags = await searchTagVocabulary(db, 'cheese');
	const ids = tags.map((t) => t.id);
	// The exact "cheese" match sorts first; the longer phrases follow it, shortest
	// name first (so "blue cheese" precedes nothing longer here).
	expect(ids[0]).toBe('ing:cheese');
	expect(ids).toContain('ing:blue cheese');
	expect(ids).toContain('ing:goat cheese');
	// Every returned tag genuinely contains the substring.
	expect(tags.every((t) => t.name.includes('cheese'))).toBe(true);
});

test('LIKE wildcards in the query are dropped, not honoured as wildcards', async () => {
	const db = freshDb();
	// The '%' is stripped, so "ve%" behaves exactly like "ve" (it must NOT act as
	// a SQL wildcard). Both yield the two curated "veg…" tags.
	const withWildcard = await searchTagVocabulary(db, 've%');
	const without = await searchTagVocabulary(db, 've');
	expect(withWildcard.map((t) => t.id)).toEqual(without.map((t) => t.id));
	expect(withWildcard.map((t) => t.id)).toEqual(['vegan', 'vegetarian']);
});
