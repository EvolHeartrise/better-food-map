/// <reference types="bun-types" />
// Client/server search-membership PARITY. The map's search rule is implemented
// twice — searchMembership on the server (the filter inside the cell read, over
// the FTS5 mirrors) and src/lib/search-match.ts on the client (the page
// re-filters the rendered set while a filtered fetch is in flight) — and
// search-fts.test.ts declares that mirror an invariant. This suite enforces it
// structurally: the same fixtures run through BOTH halves and must produce the
// same venue membership. The server half runs at the FULL grid level (see
// searchMapData in test-d1.ts), where no per-cell representative trimming
// thins the matches — rep-level trimming is a DISPLAY density rule, not a
// membership rule, covered in map-cells.test.ts.
//
// Scope (the mirror is intentionally not bit-exact, see db.ts searchMembership
// and search-match.ts headers):
//   • parity covers SEARCHABLE text only — a 3+ character wildcard-free run
//     (searchableQuery, $lib/search), which is the only text the page ever
//     sends. Shorter/wildcard-only text is filtered client-locally while the
//     server treats it as absent (issues #103/#104), pinned in its own test
//     below;
//   • the client filter is fed the same RESOLVED menus the page builds — each
//     location's menu with its per-item overrides applied (resolveLocation,
//     $lib/resolve-location). An availability:false override is a documented divergence
//     (the server searches the shared menu WITHOUT overrides) and is out of
//     scope here; a price override is resolved but never changes membership.

import { test, expect } from 'bun:test';
import { getLocationMapData } from '../src/lib/server/db';
import {
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride,
	type MenuItemInsert
} from '../src/lib/server/db-write';
import type { Item, MapData, MapLocation } from '../src/lib/server/db';
import { searchResults } from '../src/lib/search-match';
import { resolveLocation } from '../src/lib/resolve-location';
import { freshDb, searchMapData, viewportMapData } from './test-d1';
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

// A box covering every fixture venue (they spread ~0.01° per index from the
// base point) — the "viewport" the server half reads.
const BOX = { minLat: 49.2, maxLat: 49.5, minLng: -123.4, maxLng: -123.0 };

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

// The REAL page resolver ($lib/resolve-location, the same function
// +page.svelte imports), menu part only: the location's menu items with its
// overrides applied — unavailable items dropped, overridden prices used.
// (Freshness metadata plays no part in membership.) Fed the FULL item shape
// (getLocationMapData) — the page's lean viewport shape carries the same
// name+tags membership reads on, so parity over this shape covers both.
function resolveMenu(loc: MapLocation, data: MapData<Item>): Item[] {
	return resolveLocation(loc, data).menu;
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
	const server = await searchMapData(db, BOX, { query, dietTagId: diet });
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
	await expectParity(db, ids, '', 'gluten_friendly'); // nothing carries it → both empty
});

// The diet filter resolves the selected diet through the implication closure
// (dietFilterTagIds, $lib/tags): an asserted vegan tag entails vegetarian and
// dairy_free — the write path strips those entailed tags from vegan items, and
// the closure is what keeps such items matching the entailed diets. Halal is
// deliberately OUTSIDE the closure (vegan food can be non-halal, e.g. alcohol).
test('diet implication: vegan items match vegetarian/dairy_free but not halal, through both halves', async () => {
	const db = freshDb();
	const ids = await fixtures(db);
	const [palace] = ids;

	// The fixtures' vegan items carry ONLY the vegan tag (as the write path
	// guarantees) — the entailed diets must still find them.
	for (const diet of ['vegetarian', 'dairy_free']) {
		await expectParity(db, ids, '', diet);
		await expectParity(db, ids, 'burrito', diet);
		const server = await searchMapData(db, BOX, { query: '', dietTagId: diet });
		expect(server.locations.map((l) => l.id)).toContain(palace);
	}
	// Halal stays independent: nothing here is halal-tagged, so both halves are empty.
	await expectParity(db, ids, '', 'halal');
	const halal = await searchMapData(db, BOX, { query: '', dietTagId: 'halal' });
	expect(halal.locations).toEqual([]);
});

// The write path silently strips tags an asserted vegan entails (from the
// required AND optional sets), while an OPTIONAL vegan strips nothing.
test('item writes strip vegan-entailed tags; optional vegan does not dominate', async () => {
	const db = freshDb();
	const [stripped, kept] = await insertLocations(db, [venue('Strip Test'), venue('Keep Test', 1)]);
	// Asserted vegan + redundant asserted vegetarian + redundant optional dairy_free.
	await insertFoods(db, [
		{
			location_id: stripped,
			item_name: 'Vegan Bowl',
			tags: ['vegan', 'vegetarian'],
			optionalTags: ['dairy_free'],
			price: 9
		}
	]);
	// Only OPTIONAL vegan ("can be made vegan") → vegetarian must survive.
	await insertFoods(db, [
		{
			location_id: kept,
			item_name: 'Veggie Bowl',
			tags: ['vegetarian'],
			optionalTags: ['vegan'],
			price: 9
		}
	]);

	const strippedData = await getLocationMapData(db, stripped);
	const strippedMenu = resolveMenu(strippedData.locations[0], strippedData);
	expect(strippedMenu[0].tags.map((t) => t.id).toSorted()).toEqual(['vegan']);
	const keptData = await getLocationMapData(db, kept);
	const keptMenu = resolveMenu(keptData.locations[0], keptData);
	expect(keptMenu[0].tags.map((t) => t.id).toSorted()).toEqual(['vegan', 'vegetarian']);

	// And the stripped item still matches the entailed diets through both halves.
	await expectParity(db, [stripped, kept], '', 'vegetarian');
	await expectParity(db, [stripped, kept], '', 'dairy_free');
});

// Case folding is ASCII-ONLY on BOTH halves: SQLite's LIKE folds A-Z alone, so
// 'É' and 'é' stay distinct on the server — and the client folds with
// foldAsciiCase to match exactly. (Unicode .toLowerCase() on the client would
// keep venues the filtered cell read drops: a marker that vanishes the moment
// the fetch lands — and would collapse store keys for queries the server
// answers differently.)
test('non-ASCII case is significant through both halves (ASCII-only folding)', async () => {
	const db = freshDb();
	const [cafe] = await insertLocations(db, [venue('Café Crème')]);
	await insertFoods(db, [{ location_id: cafe, item_name: 'Crêpe Sucrée', price: 7 }]);
	const ids = [cafe];

	// The exact-accent query matches; ASCII letters fold both ways.
	const hit = await searchMapData(db, BOX, { query: 'CAFé', dietTagId: null });
	expect(hit.locations.map((l) => l.id)).toEqual([cafe]);
	// A case-variant of the non-ASCII letter does NOT match (É ≠ é) — on the
	// server, and therefore on the client too.
	const miss = await searchMapData(db, BOX, { query: 'CAFÉ', dietTagId: null });
	expect(miss.locations).toEqual([]);

	// And membership stays identical through both halves for every variant,
	// name and item dimensions alike.
	await expectParity(db, ids, 'café');
	await expectParity(db, ids, 'CAFé');
	await expectParity(db, ids, 'CAFÉ');
	await expectParity(db, ids, 'crêpe');
	await expectParity(db, ids, 'CRÊPE');
});

// Browse (no text, no diet) is parity too now that the search rides the cell
// read: an empty filter is simply the unfiltered read — every candidate — and
// the client keeps everything as well.
test('browse mode: an empty filter returns every candidate through both halves', async () => {
	const db = freshDb();
	const ids = await fixtures(db);

	const server = await searchMapData(db, BOX, { query: '', dietTagId: null });
	expect(server.locations.map((l) => l.id).toSorted()).toEqual(ids.toSorted());

	const candidates = await clientCandidates(db, ids);
	const kept = searchResults(candidates, '', null);
	expect(kept.map((r) => r.loc.id).toSorted()).toEqual(ids.toSorted());
	// Browse teases the whole (resolved) menu.
	for (const r of kept) expect(r.items).toEqual(r.loc.menu);
});

// The one asymmetry by design (issues #103/#104): text the trigram index
// cannot serve — no 3+ character wildcard-free run (searchableQuery,
// $lib/search) — is CLIENT-LOCAL. The page narrows it over the unfiltered
// cells it already has; the server (reached with such text only by a forged
// request, since the page sends the gated text) treats it as absent rather
// than full-scanning the FTS mirrors: the plain browse read with no diet,
// the diet-only filter with one.
test('unsearchable text is client-only: the server treats it as absent', async () => {
	const db = freshDb();
	const ids = await fixtures(db);
	const [palace, , , joe, , wildcard] = ids;

	for (const q of ['jo', 'k', '%', 'r_s']) {
		const server = await searchMapData(db, BOX, { query: q, dietTagId: null });
		expect(server.locations.map((l) => l.id).toSorted()).toEqual(ids.toSorted());
	}
	// The client still filters short text over its candidates, exactly as before.
	const candidates = await clientCandidates(db, ids);
	const clientIds = searchResults(candidates, 'jo', null).map((r) => r.loc.id);
	expect(clientIds.toSorted()).toEqual([joe, wildcard].toSorted());
	// With a diet active the server degrades to diet-only rather than widening
	// back to browse.
	const degraded = await searchMapData(db, BOX, { query: 'jo', dietTagId: 'vegan' });
	const dietOnly = await searchMapData(db, BOX, { query: '', dietTagId: 'vegan' });
	expect(degraded.locations.map((l) => l.id).toSorted()).toEqual(
		dietOnly.locations.map((l) => l.id).toSorted()
	);
	expect(degraded.locations.map((l) => l.id)).toContain(palace);
});

// The lean payload CAPS each menu to its top items (REP_ITEM_CAP, $lib/server/db),
// so the client re-filter can no longer see a matching item that was CUT — and
// the map plots markers from that re-filter (+page.svelte `results`), so a naive
// item-based exclusion would VANISH a marker for a venue the server did return.
// The two tests below drive the REAL capped payload (viewport/search reads,
// unlike the uncapped by-id read the parity fixtures above use), resolve it the
// way the page does, and assert the fail-open keeps the venue.

test('cap fail-open: a browse venue whose only sub-gate item match was cut still keeps its marker', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Big Co', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Big Co CA', region: 'CA' });
	// Twelve items; the ONLY item containing "zz" sorts last, so the top-10 cap cuts it.
	const items: MenuItemInsert[] = Array.from({ length: 11 }, (_, k) => ({
		menu_id: menuId,
		item_name: `Item ${String(k).padStart(2, '0')}`,
		price: 5
	}));
	items.push({ menu_id: menuId, item_name: 'Zzz Burrito', price: 6 });
	await insertMenuItems(db, items);
	const [branch] = await insertLocations(db, [
		{ ...venue('Big Branch'), brand_id: brandId, menu_id: menuId }
	]);

	// The browse payload is capped (12 → 10). The client filters the sub-searchable
	// term "zz" LOCALLY over these browse cells — and its only match ("Zzz Burrito")
	// was cut. Pre-fix that hid the marker; the truncation flag must keep it.
	const browse = await viewportMapData(db, BOX);
	const resolved = browse.locations.map((l) => resolveLocation(l, browse));
	expect(resolved.find((l) => l.id === branch)?.menuTruncated).toBe(true);
	const kept = searchResults(resolved, 'zz', null).map((r) => r.loc.id);
	expect(kept).toContain(branch);
});

test('cap fail-open: a diet venue whose shipped matches are all override-hidden still keeps its marker', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Veg Co', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Veg Co CA', region: 'CA' });
	// Eleven vegan items: the cap ships the 10 alphabetically-first; this branch
	// makes exactly those 10 unavailable, so its ONLY available vegan item (the
	// 11th) is precisely the one the cap cut.
	const vegan: MenuItemInsert[] = Array.from({ length: 11 }, (_, k) => ({
		menu_id: menuId,
		item_name: `Vegan ${String(k).padStart(2, '0')}`,
		tags: ['vegan'],
		price: 5
	}));
	const itemIds = await insertMenuItems(db, vegan);
	const [branch] = await insertLocations(db, [
		{ ...venue('Veg Branch'), brand_id: brandId, menu_id: menuId }
	]);
	for (let k = 0; k < 10; k++) {
		await setLocationItemOverride(db, branch, itemIds[k], { available: false });
	}

	// The vegan read ships the 10 (all hidden at this branch); resolveLocation drops
	// them, leaving an EMPTY resolved menu. Membership is server-correct (the shared
	// menu has vegan items), and the truncation flag must stop the client hiding it.
	const vroot = await searchMapData(db, BOX, { query: '', dietTagId: 'vegan' });
	const branchRes = vroot.locations
		.map((l) => resolveLocation(l, vroot))
		.find((l) => l.id === branch);
	expect(branchRes).toBeDefined();
	expect(branchRes?.menu.length).toBe(0); // every shipped vegan item hidden here
	expect(branchRes?.menuTruncated).toBe(true);
	const kept = searchResults(
		vroot.locations.map((l) => resolveLocation(l, vroot)),
		'',
		'vegan'
	).map((r) => r.loc.id);
	expect(kept).toContain(branch);
});
