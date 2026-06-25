/// <reference types="bun-types" />
// Exercises getTagSuggestions (the read behind the `getTagSuggestions` remote
// that backs the tag pickers' default list and the popularity re-rank of typed
// results). It mines `search_history` (written by logSearch) for one filter mode
// — `included_tags` for 'include', `excluded_tags` for 'exclude' — ranking the
// most-searched tags across all users, with the signed-in user's own
// recently-used tags floated to the front. Runs against the real migration
// schema via the in-memory D1Like adapter, so it also covers the `json_each` /
// `json_extract` expansion of the stored tag JSON and the JOIN back to `tags`.

import { test, expect } from 'bun:test';
import { getTagSuggestions, logSearch, type Tag } from '../src/lib/server/db';
import { freshDb, type TestD1 } from './test-d1';

/** A bare {id,name,tag_type}; only the id matters to the query (it JOINs by id). */
function tag(id: string): Tag {
	return { id, name: id, tag_type: 'dietary' };
}

/** Logs one search for `userId`, with explicit tag lists and timestamp. */
async function log(
	db: TestD1,
	userId: string,
	opts: { included?: Tag[]; excluded?: Tag[]; at: number }
): Promise<void> {
	await logSearch(db, {
		id: crypto.randomUUID(),
		userId,
		place: '',
		item: '',
		included: opts.included ?? [],
		excluded: opts.excluded ?? [],
		createdAt: opts.at
	});
}

test('no history yields no suggestions', async () => {
	const db = freshDb();
	expect(await getTagSuggestions(db, null, 'include')).toEqual([]);
	expect(await getTagSuggestions(db, 'user-a', 'exclude')).toEqual([]);
});

test('global suggestions rank by how often a tag is searched in that mode', async () => {
	const db = freshDb();
	// `vegan` is included in three searches, `vegetarian` in one.
	await log(db, 'user-a', { included: [tag('vegan')], at: 1 });
	await log(db, 'user-a', { included: [tag('vegan')], at: 2 });
	await log(db, 'user-b', { included: [tag('vegan')], at: 3 });
	await log(db, 'user-b', { included: [tag('vegetarian')], at: 4 });
	// Signed out (userId null): pure global popularity, most-searched first.
	const ids = (await getTagSuggestions(db, null, 'include')).map((t) => t.id);
	expect(ids).toEqual(['vegan', 'vegetarian']);
});

test("a user's own recently-used tags come before more popular ones", async () => {
	const db = freshDb();
	// Globally `vegan` is by far the most popular (three searches).
	await log(db, 'user-a', { included: [tag('vegan')], at: 1 });
	await log(db, 'user-a', { included: [tag('vegan')], at: 2 });
	await log(db, 'user-a', { included: [tag('vegan')], at: 3 });
	// But user-b last used `gluten_free`, then `vegetarian` (most recent).
	await log(db, 'user-b', { included: [tag('gluten_free')], at: 10 });
	await log(db, 'user-b', { included: [tag('vegetarian')], at: 11 });
	const ids = (await getTagSuggestions(db, 'user-b', 'include')).map((t) => t.id);
	// user-b's own tags first (most-recent first), then the remaining popular tag.
	expect(ids).toEqual(['vegetarian', 'gluten_free', 'vegan']);
});

test('include and exclude draw on separate popularity pools', async () => {
	const db = freshDb();
	await log(db, 'user-a', { included: [tag('vegan')], excluded: [tag('dairy_free')], at: 1 });
	expect((await getTagSuggestions(db, null, 'include')).map((t) => t.id)).toEqual(['vegan']);
	expect((await getTagSuggestions(db, null, 'exclude')).map((t) => t.id)).toEqual(['dairy_free']);
});

test('a stored tag whose id no longer exists is dropped', async () => {
	const db = freshDb();
	// `ing:ghost` was never created in `tags`, so the JOIN drops it; `vegan` (a
	// curated tag seeded by migration 0001) survives.
	await log(db, 'user-a', {
		included: [tag('vegan'), { id: 'ing:ghost', name: 'Ghost', tag_type: 'ingredient' }],
		at: 1
	});
	expect((await getTagSuggestions(db, null, 'include')).map((t) => t.id)).toEqual(['vegan']);
});

test('the limit caps how many suggestions are returned', async () => {
	const db = freshDb();
	await log(db, 'user-a', {
		included: [tag('vegan'), tag('vegetarian'), tag('halal')],
		at: 1
	});
	expect((await getTagSuggestions(db, null, 'include', 2)).length).toBe(2);
	expect((await getTagSuggestions(db, null, 'include', 0)).length).toBe(0);
});
