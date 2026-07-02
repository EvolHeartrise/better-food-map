/// <reference types="bun-types" />
// Exercises the FTS5 trigram path behind getSearchMapData (migration 0016). The
// search's text matching now resolves through the locations_fts / items_fts
// mirrors, so these tests pin down the two things that must hold forever:
//
//   1. SEMANTICS ARE UNCHANGED. The client mirrors the server's membership with
//      case-insensitive substring `.includes()` (+page.svelte matchedItems/
//      results), so the FTS route must match exactly what a bare
//      `LIKE '%q%' ESCAPE '\'` over the base tables matched: interior
//      substrings, ASCII case-insensitivity, literal `%`/`_` wildcards in the
//      query, 1–2 character queries (below the trigram width — correct, just
//      unaccelerated), the venue-name OR item-name membership with the diet
//      filter narrowing on the SAME item, and nearest-first ordering.
//
//   2. THE MIRRORS STAY IN SYNC. Every insert/rename/delete of a location or
//      item flows through the 0016 triggers, so a renamed venue is found under
//      its new name only, and a deleted one not at all.
//
// Runs against the real migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	getSearchMapData,
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	updateLocations,
	updateItems,
	deleteLocation,
	deleteItem,
	setLocationClosed
} from '../src/lib/server/db';
import { freshDb } from './test-d1';
import type { TestD1 } from './test-d1';

const addr = {
	street: '1 Test St',
	city: 'Vancouver',
	region: 'BC',
	postcode: 'V6J 1M5',
	country: 'CA',
	phone: null,
	website: null
};

const anchor = { lat: 49.28, lng: -123.12 };

/** Ids returned by a text(+diet) search, anchored at the fixed test point. */
async function searchIds(db: TestD1, query: string, dietTagId: string | null = null) {
	const res = await getSearchMapData(db, { query, dietTagId, ...anchor });
	return res.locations.map((l) => l.id);
}

/** Shorthand: one venue at the anchor (offset a touch so ids stay distinct). */
function venue(name: string, i = 0) {
	return {
		name,
		category: 'restaurant' as const,
		latitude: 49.28 + i * 0.01,
		longitude: -123.12 - i * 0.01,
		...addr
	};
}

test('search matches interior substrings of venue and item names, case-insensitively', async () => {
	const db = freshDb();
	const [barn, joe] = await insertLocations(db, [venue('Burrito Barn'), venue('Joe Diner', 1)]);
	await insertFoods(db, [{ location_id: barn, item_name: 'Steak Plate', price: 14 }]);
	await insertFoods(db, [{ location_id: joe, item_name: 'Veggie Burrito', price: 11 }]);

	// Interior substring — 'rrito' is not a word prefix in either dimension.
	expect((await searchIds(db, 'rrito')).toSorted()).toEqual([barn, joe].toSorted());
	// Case-insensitive both ways (upper query / mixed-case names).
	expect((await searchIds(db, 'BURRITO')).toSorted()).toEqual([barn, joe].toSorted());
	expect((await searchIds(db, 'veggie burrito')).toSorted()).toEqual([joe]);
	// The item dimension alone.
	expect(await searchIds(db, 'steak')).toEqual([barn]);
	// No match at all.
	expect(await searchIds(db, 'sushi')).toEqual([]);
});

// Queries shorter than a trigram can't use the index — FTS5 falls back to
// scanning the table — but they must still MATCH exactly like a substring LIKE.
test('1–2 character queries still match by substring', async () => {
	const db = freshDb();
	const [pho, zab] = await insertLocations(db, [venue('Pho King'), venue('Zab Zab', 1)]);
	await insertFoods(db, [{ location_id: pho, item_name: 'Ox Tail Soup', price: 9 }]);

	expect(await searchIds(db, 'ph')).toEqual([pho]);
	expect(await searchIds(db, 'za')).toEqual([zab]);
	// Single character, matched through the ITEM dimension ('Ox Tail Soup').
	expect(await searchIds(db, 'x')).toEqual([pho]);
	expect(await searchIds(db, 'q')).toEqual([]);
});

// `%` and `_` in the query are user text, not LIKE wildcards: escapeLikePattern
// keeps them literal (and only then does the SQL carry an ESCAPE clause).
test('LIKE wildcard characters in the query match literally', async () => {
	const db = freshDb();
	const [beef, kale, under] = await insertLocations(db, [
		venue("Joe's 100% Beef"),
		venue('100 Percent Kale', 1),
		venue('Under_Score Cafe', 2)
	]);
	// Would match query 'r_s' if '_' leaked through as "any one character" ('Ros').
	await insertLocations(db, [venue('Rose Diner', 3)]);
	await insertFoods(db, [{ location_id: kale, item_name: '50% Off Wings', price: 6 }]);

	// An unescaped LIKE '%100%%' would match BOTH venues; literal '100%' only one.
	expect(await searchIds(db, '100%')).toEqual([beef]);
	// A bare '%' means "a name containing a percent sign", not "everything".
	expect((await searchIds(db, '%')).toSorted()).toEqual([beef, kale].toSorted());
	// '_' is a literal underscore, not "any one character": 'Under_Score' matches,
	// 'Rose Diner' (which r_s-as-wildcard WOULD match, via 'Ros') must not.
	expect(await searchIds(db, 'r_s')).toEqual([under]);
	// Wildcards stay literal through the ITEM dimension too.
	expect(await searchIds(db, '50%')).toEqual([kale]);
	// A backslash is also literal (it is the escape character in the pattern).
	expect(await searchIds(db, '\\')).toEqual([]);
});

test('diet narrows a name match, and text+diet must hold on the SAME item', async () => {
	const db = freshDb();
	const [palace, barn, taco, joe] = await insertLocations(db, [
		venue('Burrito Palace'),
		venue('Burrito Barn', 1),
		venue('Taco Town', 2),
		venue('Joe Diner', 3)
	]);
	// Palace: name matches, and SOME item is vegan (the item need not match the text).
	await insertFoods(db, [
		{ location_id: palace, item_name: 'Green Bowl', tags: ['vegan'], price: 10 }
	]);
	// Barn: name matches but nothing vegan → the diet filter must drop it.
	await insertFoods(db, [{ location_id: barn, item_name: 'Steak Plate', price: 14 }]);
	// Taco Town: has a burrito AND a vegan item, but not the same item → drops.
	await insertFoods(db, [
		{ location_id: taco, item_name: 'Beef Burrito', price: 12 },
		{ location_id: taco, item_name: 'Vegan Salad', tags: ['vegan'], price: 8 }
	]);
	// Joe: one item satisfies BOTH predicates at once.
	await insertFoods(db, [
		{ location_id: joe, item_name: 'Veggie Burrito', tags: ['vegan'], price: 11 }
	]);

	expect((await searchIds(db, 'burrito')).toSorted()).toEqual([palace, barn, taco, joe].toSorted());
	expect((await searchIds(db, 'burrito', 'vegan')).toSorted()).toEqual([palace, joe].toSorted());
});

test('matches come back nearest the anchor first', async () => {
	const db = freshDb();
	// Same latitude, increasing longitude distance from the anchor — inserted shuffled
	// so the order can only come from the distance ranking.
	const [far, near, mid] = await insertLocations(db, [
		{ ...venue('Noodle Far'), longitude: anchor.lng - 0.3 },
		{ ...venue('Noodle Near'), longitude: anchor.lng - 0.01 },
		{ ...venue('Noodle Mid'), longitude: anchor.lng - 0.1 }
	]);

	expect(await searchIds(db, 'noodle')).toEqual([near, mid, far]);
});

test('sync triggers: a renamed venue is found under its new name only; a deleted one not at all', async () => {
	const db = freshDb();
	const [id] = await insertLocations(db, [venue('Old Name Cafe')]);
	expect(await searchIds(db, 'old name')).toEqual([id]);

	await updateLocations(db, [{ id, name: 'Fresh Start Bistro' }]);
	expect(await searchIds(db, 'fresh start')).toEqual([id]);
	expect(await searchIds(db, 'old name')).toEqual([]);

	// The mirror itself holds exactly the renamed row (trigger-level check).
	const { results: mirror } = await db
		.prepare(`SELECT id, name FROM locations_fts`)
		.all<{ id: string; name: string }>();
	expect(mirror).toEqual([{ id, name: 'Fresh Start Bistro' }]);

	await deleteLocation(db, id);
	expect(await searchIds(db, 'fresh start')).toEqual([]);
	const { results: after } = await db.prepare(`SELECT id FROM locations_fts`).all();
	expect(after).toEqual([]);
});

test('sync triggers: item inserts (private and shared menus), renames and deletes', async () => {
	const db = freshDb();
	const [indie] = await insertLocations(db, [venue('Indie Cafe')]);
	const [soupId] = await insertFoods(db, [
		{ location_id: indie, item_name: 'Mushroom Soup', price: 7 }
	]);
	expect(await searchIds(db, 'mushroom')).toEqual([indie]);

	// A shared chain menu's items are searchable from every branch serving it.
	const brandId = await insertBrand(db, { name: 'Wok Stop', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Wok Stop CA', region: 'CA' });
	const [chowId] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Chow Mein', price: 10 }
	]);
	const [branch] = await insertLocations(db, [
		{ ...venue('Wok Stop Downtown', 1), brand_id: brandId, menu_id: menuId }
	]);
	expect(await searchIds(db, 'chow mein')).toEqual([branch]);

	// Renames propagate: found under the new name, not the old.
	await updateItems(db, [{ id: soupId, item_name: 'Truffle Pasta' }]);
	expect(await searchIds(db, 'truffle')).toEqual([indie]);
	expect(await searchIds(db, 'mushroom')).toEqual([]);

	// Deletes drop out of the item dimension (both menu kinds).
	await deleteItem(db, soupId);
	expect(await searchIds(db, 'truffle')).toEqual([]);
	await deleteItem(db, chowId);
	expect(await searchIds(db, 'chow mein')).toEqual([]);
	const { results: mirror } = await db.prepare(`SELECT id FROM items_fts`).all();
	expect(mirror).toEqual([]);
});

// The mirror deliberately does NOT track closed_at (migration 0016): hiding a
// closed venue is the outer query's `closed_at IS NULL` filter, so closing needs
// no FTS write and reopening restores searchability with none either.
test('closed venues stay out of search results, reopened ones return', async () => {
	const db = freshDb();
	const [open, tomb] = await insertLocations(db, [
		venue('Living Bakery'),
		{
			...venue('Ghost Bakery', 1),
			closed_at: 1700000000000,
			closed_reason: 'permanently closed (test)'
		}
	]);

	// A born-closed tombstone never surfaces.
	expect(await searchIds(db, 'bakery')).toEqual([open]);

	// Soft-deleting hides; reopening restores — with the mirror untouched throughout.
	await setLocationClosed(db, open, 1700000000000, 'closed (test)');
	expect(await searchIds(db, 'bakery')).toEqual([]);
	await setLocationClosed(db, open, null, null);
	expect(await searchIds(db, 'bakery')).toEqual([open]);
	const { results: mirror } = await db
		.prepare(`SELECT id FROM locations_fts ORDER BY name`)
		.all<{ id: string }>();
	expect(mirror.map((r) => r.id).toSorted()).toEqual([open, tomb].toSorted());
});
