/// <reference types="bun-types" />
// Client/server search-membership PARITY. The map's search rule is implemented
// twice — getSearchMapData on the server (FTS5 mirrors) and src/lib/search-match.ts
// on the client (the page re-filters the result set while a search is in flight) —
// and search-fts.test.ts declares that mirror an invariant. This suite enforces it
// structurally: the same fixtures run through BOTH halves and must produce the
// same venue membership.
//
// Scope (the mirror is intentionally not bit-exact, see db.ts getSearchMapData and
// search-match.ts headers):
//   • parity is asserted in SEARCH MODE only (text and/or diet active) — client
//     browse mode (keep everything) has no server counterpart (the server returns
//     empty for no-query/no-diet), pinned in its own test below;
//   • parity covers SEARCHABLE text only — a 3+ character wildcard-free run
//     (searchableQuery, $lib/search), which is the only text the page ever
//     sends. Shorter/wildcard-only text is filtered client-locally and the
//     server treats it as absent (issues #103/#104), pinned in its own test
//     below;
//   • the client filter is fed the same RESOLVED menus the page builds — each
//     location's menu with its per-item overrides applied (resolveLocation,
//     +page.svelte). An availability:false override is a documented divergence
//     (the server searches the shared menu WITHOUT overrides) and is out of
//     scope here; a price override is resolved but never changes membership.

import { test, expect } from 'bun:test';
import {
	getSearchMapData,
	getLocationMapData,
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride
} from '../src/lib/server/db';
import type { Item, MapData, MapLocation } from '../src/lib/server/db';
import { searchResults } from '../src/lib/search-match';
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

/** One venue near the anchor (offset a touch so ids stay distinct). */
function venue(name: string, i = 0) {
	return {
		name,
		category: 'restaurant' as const,
		latitude: 49.28 + i * 0.01,
		longitude: -123.12 - i * 0.01,
		...addr
	};
}

// Mirror of +page.svelte's resolveLocation, menu part only: the location's menu
// items with its overrides applied — unavailable items dropped, overridden
// prices used. (Freshness metadata plays no part in membership.)
function resolveMenu(loc: MapLocation, data: MapData): Item[] {
	const menu: Item[] = [];
	if (loc.menu_id) {
		const overrideByItem = new Map(loc.overrides.map((o) => [o.item_id, o]));
		for (const menuItem of data.menus[loc.menu_id] ?? []) {
			const override = overrideByItem.get(menuItem.id);
			if (override?.available === false) continue;
			if (override !== undefined && override.price !== null) {
				menu.push({ ...menuItem, price: override.price });
			} else {
				menu.push(menuItem);
			}
		}
	}
	return menu;
}

/**
 * The client's candidate set for the given venue ids: each location fetched in
 * the wire shape the page receives (getLocationMapData) and resolved the way
 * the page resolves it. Fetched per id rather than via getMapData so the
 * candidate set can never be thinned by the wide-viewport grid downsampling.
 */
async function clientCandidates(db: TestD1, ids: string[]) {
	const out: Array<{ id: string; name: string; menu: Item[] }> = [];
	for (const id of ids) {
		const data = await getLocationMapData(db, id);
		const loc = data.locations[0];
		if (!loc) continue;
		out.push({ id: loc.id, name: loc.name, menu: resolveMenu(loc, data) });
	}
	return out;
}

/** Assert both halves keep exactly the same venues for this query/diet. */
async function expectParity(db: TestD1, ids: string[], query: string, diet: string | null = null) {
	const server = await getSearchMapData(db, { query, dietTagId: diet, ...anchor });
	const serverIds = server.locations.map((l) => l.id).toSorted();
	const clientIds = searchResults(await clientCandidates(db, ids), query, diet)
		.map((r) => r.loc.id)
		.toSorted();
	expect(clientIds).toEqual(serverIds);
}

/**
 * One fixture set exercising every membership rule the two halves share:
 * name-only matches (with and without a menu), item-only matches, the
 * text+diet same-item rule, a shared chain menu across branches, and a
 * price override on one branch.
 */
async function fixtures(db: TestD1): Promise<string[]> {
	const [palace, barn, taco, joe, empty, wildcard, rose] = await insertLocations(db, [
		venue('Burrito Palace'),
		venue('Burrito Barn', 1),
		venue('Taco Town', 2),
		venue('Joe Diner', 3),
		venue('Empty Burrito Hut', 4), // name matches, NO menu at all
		venue("Joe's 100% Beef", 5), // literal-wildcard name
		venue('Rose Diner', 8) // matches 'r_s' only if '_' leaks as a wildcard
	]);
	// Palace: name matches 'burrito', and SOME item is vegan (item need not match text).
	await insertFoods(db, [
		{ location_id: palace, item_name: 'Green Bowl', tags: ['vegan'], price: 10 }
	]);
	// Barn: name matches but nothing vegan → dropped once diet narrows.
	await insertFoods(db, [{ location_id: barn, item_name: 'Steak Plate', price: 14 }]);
	// Taco Town: a burrito AND a vegan item, but never the same item.
	await insertFoods(db, [
		{ location_id: taco, item_name: 'Beef Burrito', price: 12 },
		{ location_id: taco, item_name: 'Vegan Salad', tags: ['vegan'], price: 8 }
	]);
	// Joe: one item satisfies text AND diet at once.
	await insertFoods(db, [
		{ location_id: joe, item_name: 'Veggie Burrito', tags: ['vegan'], price: 11 }
	]);

	// A chain: two branches serving one shared menu, one branch with a price
	// override (resolved by the client, membership-neutral by design).
	const brandId = await insertBrand(db, { name: 'Wok Stop', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Wok Stop CA', region: 'CA' });
	const [chowId] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Chow Mein', price: 10 },
		{ menu_id: menuId, item_name: 'Vegan Chow Mein', tags: ['vegan'], price: 11 }
	]);
	const [downtown, uptown] = await insertLocations(db, [
		{ ...venue('Wok Stop Downtown', 6), brand_id: brandId, menu_id: menuId },
		{ ...venue('Wok Stop Uptown', 7), brand_id: brandId, menu_id: menuId }
	]);
	await setLocationItemOverride(db, uptown, chowId, { price: 12 });

	return [palace, barn, taco, joe, empty, wildcard, rose, downtown, uptown];
}

test('text-only queries: same membership through both halves', async () => {
	const db = freshDb();
	const ids = await fixtures(db);

	// Name and item dimensions, interior substrings, case-insensitivity.
	await expectParity(db, ids, 'burrito');
	await expectParity(db, ids, 'BURRITO');
	await expectParity(db, ids, 'rrito');
	await expectParity(db, ids, 'steak'); // item dimension only
	await expectParity(db, ids, 'chow mein'); // shared menu → both branches
	await expectParity(db, ids, 'empty'); // name match with an EMPTY menu is kept
	await expectParity(db, ids, 'sushi'); // no match at all
	// LIKE wildcards stay literal on the server (via the ESCAPE form, prefiltered
	// by the '100' run's indexed LIKE); the client's .includes() is literal by
	// construction — both must agree.
	await expectParity(db, ids, '100%');
});

test('diet queries: narrowing on the SAME item agrees through both halves', async () => {
	const db = freshDb();
	const ids = await fixtures(db);

	// Diet-only: membership is "has a diet-carrying item".
	await expectParity(db, ids, '', 'vegan');
	// Text+diet: Palace kept (name + some vegan item), Barn dropped (no vegan),
	// Taco dropped (burrito and vegan never the same item), Joe kept (same item).
	await expectParity(db, ids, 'burrito', 'vegan');
	// Shared menu through the diet dimension, both branches.
	await expectParity(db, ids, 'chow', 'vegan');
	await expectParity(db, ids, '', 'gluten_free'); // nothing carries it → both empty
});

// The one asymmetry by design: with no text and no diet the client keeps every
// candidate (browse mode) while the server returns nothing — the page only
// calls the server once a filter is set.
test('browse mode is client-only: server returns empty, client keeps all', async () => {
	const db = freshDb();
	const ids = await fixtures(db);

	const server = await getSearchMapData(db, { query: '', dietTagId: null, ...anchor });
	expect(server.locations).toEqual([]);

	const candidates = await clientCandidates(db, ids);
	const kept = searchResults(candidates, '', null);
	expect(kept.map((r) => r.loc.id).toSorted()).toEqual(ids.toSorted());
	// Browse teases the whole (resolved) menu.
	for (const r of kept) expect(r.items).toEqual(r.loc.menu);
});

// The other asymmetry by design (issues #103/#104): text the trigram index
// cannot serve — no 3+ character wildcard-free run (searchableQuery,
// $lib/search) — is CLIENT-LOCAL. The page never sends it (it keeps filtering
// what's already on screen); the server, reached with such text only by a
// forged request, treats it as absent rather than full-scanning the FTS
// mirrors: empty with no diet, degraded to diet-only with one.
test('unsearchable text is client-only: the server treats it as absent', async () => {
	const db = freshDb();
	const ids = await fixtures(db);
	const [palace, , , joe, , wildcard] = ids;

	for (const q of ['jo', 'k', '%', 'r_s']) {
		const server = await getSearchMapData(db, { query: q, dietTagId: null, ...anchor });
		expect(server.locations).toEqual([]);
	}
	// The client still filters short text over its candidates, exactly as before.
	const candidates = await clientCandidates(db, ids);
	const clientIds = searchResults(candidates, 'jo', null).map((r) => r.loc.id);
	expect(clientIds.toSorted()).toEqual([joe, wildcard].toSorted());
	// With a diet active the server degrades to diet-only rather than blanking.
	const degraded = await getSearchMapData(db, { query: 'jo', dietTagId: 'vegan', ...anchor });
	const dietOnly = await getSearchMapData(db, { query: '', dietTagId: 'vegan', ...anchor });
	expect(degraded.locations.map((l) => l.id).toSorted()).toEqual(
		dietOnly.locations.map((l) => l.id).toSorted()
	);
	expect(degraded.locations.map((l) => l.id)).toContain(palace);
});
