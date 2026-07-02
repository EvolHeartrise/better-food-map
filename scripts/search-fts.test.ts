/// <reference types="bun-types" />
// Exercises the FTS5 trigram path behind getSearchMapData (migration 0016). The
// search's text matching now resolves through the locations_fts / items_fts
// mirrors, so these tests pin down the two things that must hold forever:
//
//   1. SEMANTICS MATCH THE CLIENT. The client mirrors the server's membership
//      with case-insensitive substring `.includes()` (src/lib/search-match.ts,
//      held to parity by search-parity.test.ts), so for every query the client
//      actually sends — gated by searchableQuery ($lib/search) to text with a
//      3+ char wildcard-free run — the FTS route must match exactly what a bare
//      `LIKE '%q%' ESCAPE '\'` over the base tables matched: interior
//      substrings, ASCII case-insensitivity, literal `%`/`_` wildcards in the
//      query, the venue-name OR item-name membership with the diet filter
//      narrowing on the SAME item, and nearest-first ordering. Text BELOW the
//      gate (short/wildcard-only) is treated as absent — never full-scanned
//      (issues #103/#104).
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
	deleteMenu,
	setLocationClosed
} from '../src/lib/server/db';
import { searchableQuery, longestLiteralRun } from '../src/lib/search';
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

// Queries shorter than a trigram can't use the index — running them would full-
// scan BOTH mirrors (issues #103/#104) — so the server treats them as absent.
// The client applies the same gate and never sends them; it filters the venues
// already on screen locally instead.
test('text below the trigram width is treated as absent, never full-scanned', async () => {
	const db = freshDb();
	const [pho] = await insertLocations(db, [venue('Pho King')]);
	await insertFoods(db, [
		{ location_id: pho, item_name: 'Ox Tail Soup', tags: ['vegan'], price: 9 }
	]);

	// Short text with no diet: no searchable dimension at all → the empty guard.
	expect(await searchIds(db, 'ph')).toEqual([]);
	expect(await searchIds(db, 'x')).toEqual([]);
	// With a diet active the search degrades to diet-only rather than blanking.
	expect(await searchIds(db, 'ph', 'vegan')).toEqual([pho]);
	// At the trigram width the text dimension kicks in.
	expect(await searchIds(db, 'pho')).toEqual([pho]);
});

// `%` and `_` in the query are user text, not LIKE wildcards: escapeLikePattern
// keeps them literal (and only then does the SQL carry an ESCAPE clause, paired
// with an index-served prefilter on the longest wildcard-free run). A query
// whose longest wildcard-free run is under the trigram width is unsearchable
// text (see searchableQuery) and treated as absent, like short text above.
test('LIKE wildcard characters in the query match literally', async () => {
	const db = freshDb();
	const [beef, kale, under] = await insertLocations(db, [
		venue("Joe's 100% Beef"),
		venue('100 Percent Kale', 1),
		venue('Under_Score Cafe', 2)
	]);
	// Would match query 'under_score' if '_' leaked through as "any one character".
	await insertLocations(db, [venue('UnderXScore Cafe', 3)]);
	await insertFoods(db, [{ location_id: kale, item_name: '50% Off Wings', price: 6 }]);

	// An unescaped LIKE '%100%%' would match BOTH venues; literal '100%' only one
	// (and the '100' run prefilter narrows, never widens, that match).
	expect(await searchIds(db, '100%')).toEqual([beef]);
	// '_' is a literal underscore, not "any one character": 'Under_Score' matches,
	// 'UnderXScore' (which under_score-as-wildcard WOULD match) must not.
	expect(await searchIds(db, 'under_score')).toEqual([under]);
	// Wildcards stay literal through the ITEM dimension too.
	expect(await searchIds(db, '50% off')).toEqual([kale]);
	// Wildcard-only / wildcard-broken text has no run the index could serve:
	// treated as absent, not full-scanned ('%' used to mean "a name containing a
	// percent sign" — now it is simply not searchable).
	expect(await searchIds(db, '%')).toEqual([]);
	expect(await searchIds(db, 'r_s')).toEqual([]);
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

// The pure gate itself ($lib/search) — the single definition of "searchable"
// shared by the map page (skip the request) and getSearchMapData (ignore the
// text). Pinned here so the two sides can't drift.
test('searchableQuery gates on a 3+ character wildcard-free run', () => {
	// Short text, however padded, is unsearchable.
	expect(searchableQuery('')).toBe('');
	expect(searchableQuery('  b ')).toBe('');
	expect(searchableQuery('bu')).toBe('');
	// Three characters (the trigram width) is enough — including interior spaces,
	// which the trigram tokenizer indexes like any other character.
	expect(searchableQuery('pho')).toBe('pho');
	expect(searchableQuery(' a b ')).toBe('a b');
	// Wildcards break runs: the text is searchable only if some unbroken run
	// still reaches the width. The returned text is the WHOLE trimmed query —
	// the gate never rewrites what is searched.
	expect(searchableQuery('100%')).toBe('100%');
	expect(searchableQuery('50% off')).toBe('50% off');
	expect(searchableQuery('a%b_c\\d')).toBe('');
	expect(searchableQuery('%%%')).toBe('');
	expect(longestLiteralRun('a%burrito_x')).toBe('burrito');
});

// --- migration 0020: mirror maintenance keyed by rowid via *_fts_map --------
//
// The 0016 triggers filtered the mirrors on their UNINDEXED id — FTS5 offers
// no pushdown for that, so every UPDATE/DELETE trigger firing scanned the
// whole mirror (issue #91). 0020 adds id→rowid map tables and re-keys the
// triggers on the mirror's own rowid. Pinned here: (a) the maps stay in
// perfect lockstep through every write path, cascades included, and (b) the
// trigger's WHERE shape actually reaches FTS5's rowid-equality plan.

/** Zero-desync check: map ↔ mirror agree row-for-row and track the base table. */
async function mapDesync(db: TestD1, base: 'locations' | 'items') {
	const count = async (sql: string) =>
		((await db.prepare(sql).first<{ n: number }>()) ?? { n: -1 }).n;
	return {
		// fts rows whose exact (rowid, id) pair is missing from the map…
		orphans: await count(
			`SELECT COUNT(*) AS n FROM ${base}_fts f
			 LEFT JOIN ${base}_fts_map m ON m.fts_rowid = f.rowid AND m.id = f.id
			 WHERE m.id IS NULL`
		),
		// …and map rows pointing at no fts row.
		strays: await count(
			`SELECT COUNT(*) AS n FROM ${base}_fts_map m
			 LEFT JOIN ${base}_fts f ON f.rowid = m.fts_rowid AND f.id = m.id
			 WHERE f.id IS NULL`
		),
		drift:
			(await count(`SELECT COUNT(*) AS n FROM ${base}_fts_map`)) -
			(await count(`SELECT COUNT(*) AS n FROM ${base}`))
	};
}

test('rowid maps stay in lockstep with the mirrors through every write path', async () => {
	const db = freshDb();
	const clean = { orphans: 0, strays: 0, drift: 0 };
	const expectClean = async () => {
		expect(await mapDesync(db, 'locations')).toEqual(clean);
		expect(await mapDesync(db, 'items')).toEqual(clean);
	};

	// Inserts: independent venue with private-menu items, plus a chain menu.
	const [indie, spare] = await insertLocations(db, [venue('Indie Cafe'), venue('Spare Venue', 1)]);
	const [soupId, saladId] = await insertFoods(db, [
		{ location_id: indie, item_name: 'Mushroom Soup', price: 7 },
		{ location_id: indie, item_name: 'Garden Salad', price: 6 }
	]);
	const brandId = await insertBrand(db, { name: 'Wok Stop', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Wok Stop CA', region: 'CA' });
	await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Chow Mein', price: 10 },
		{ menu_id: menuId, item_name: 'Spring Rolls', price: 5 }
	]);
	await expectClean();

	// Renames rewrite the mirror row in place — same rowid, same map row.
	await updateLocations(db, [{ id: indie, name: 'Indie Bistro' }]);
	await updateItems(db, [{ id: soupId, item_name: 'Truffle Pasta' }]);
	await expectClean();
	expect(await searchIds(db, 'truffle')).toEqual([indie]);

	// Single deletes and the menu→items cascade (deleting a location leaves its
	// private menu's rows behind, so the items go one by one here).
	await deleteItem(db, soupId);
	await expectClean();
	await deleteMenu(db, menuId);
	await expectClean();
	await deleteItem(db, saladId);
	await deleteLocation(db, indie);
	await deleteLocation(db, spare);
	await expectClean();
	expect((await db.prepare(`SELECT COUNT(*) AS n FROM items_fts`).first<{ n: number }>())?.n).toBe(
		0
	);
});

test('mirror maintenance reaches the FTS5 rowid-equality plan, not a full scan', async () => {
	const db = freshDb();
	const plan = async (sql: string) =>
		(await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results
			.map((r) => r.detail)
			.join(' | ');

	// The pre-0020 shape — filtering the UNINDEXED id — is a bare virtual-table
	// scan: idxStr '0:' with no constraint after the colon.
	const old = await plan(`DELETE FROM items_fts WHERE id = 'x'`);
	expect(old).toContain('VIRTUAL TABLE INDEX 0:');
	expect(old).not.toContain('INDEX 0:=');

	// The trigger shape: FTS5 rowid equality ('0:=') fed by an indexed map lookup.
	const fixed = await plan(
		`DELETE FROM items_fts WHERE rowid = (SELECT fts_rowid FROM items_fts_map WHERE id = 'x')`
	);
	expect(fixed).toContain('VIRTUAL TABLE INDEX 0:=');
	expect(fixed).toContain('COVERING INDEX');
});
