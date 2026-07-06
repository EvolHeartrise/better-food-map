/// <reference types="bun-types" />
// Tests the brand/menu reference validation behind update_items (menu moves) and
// update_locations (single-sided brand_id/menu_id patches) against the real
// migration schema via the in-memory D1 adapter. These guards close two holes:
// an unvalidated update_items menu_id silently relocating an item onto another
// venue's private menu or another brand's menu, and a lone { brand_id: null } /
// { brand_id: "B" } location patch leaving exactly the brand/menu shapes
// assertBrandMenuRefs exists to prevent.

import { test, expect } from 'bun:test';
import { type D1Like } from '../../src/lib/server/db';
import {
	insertBrand,
	insertMenu,
	insertMenuItems,
	insertLocations,
	getItemById,
	getLocationById,
	getMenuWithItems,
	updateItems,
	updateLocations
} from '../../src/lib/server/db-write';
import { assertItemMenuMoves, assertLocationRefPatches } from './ref-validation';
import { freshDb } from '../test-d1';

const ADDR = {
	street: '1 Test St',
	city: 'Vancouver',
	region: 'BC',
	postcode: 'V6J 1M5',
	country: 'CA'
};

const LOC = {
	category: null,
	latitude: 1,
	longitude: 1,
	...ADDR,
	phone: null,
	website: null
} as const;

/**
 * Two brands, two shared menus each for brand A (a legitimate same-brand move
 * target), one chain branch per brand, and two independent venues with one
 * private-menu item each.
 */
async function seed(db: D1Like) {
	await insertBrand(db, {
		id: 'brand-a',
		name: 'Brand A',
		website: null,
		logo_url: null
	});
	await insertBrand(db, {
		id: 'brand-b',
		name: 'Brand B',
		website: null,
		logo_url: null
	});
	await insertMenu(db, {
		id: 'menu-a1',
		brand_id: 'brand-a',
		name: 'Brand A CA',
		region: 'CA'
	});
	await insertMenu(db, {
		id: 'menu-a2',
		brand_id: 'brand-a',
		name: 'Brand A US',
		region: 'US'
	});
	await insertMenu(db, {
		id: 'menu-b',
		brand_id: 'brand-b',
		name: 'Brand B CA',
		region: 'CA'
	});
	await insertMenuItems(db, [
		{ id: 'item-a', menu_id: 'menu-a1', item_name: 'Shared Burger' },
		{ id: 'item-b', menu_id: 'menu-b', item_name: 'Other Chain Wrap' }
	]);
	await insertLocations(db, [
		{
			id: 'branch-a',
			name: 'Brand A #1',
			...LOC,
			brand_id: 'brand-a',
			menu_id: 'menu-a1'
		},
		{
			id: 'branch-b',
			name: 'Brand B #1',
			...LOC,
			longitude: 2,
			brand_id: 'brand-b',
			menu_id: 'menu-b'
		},
		{
			id: 'indie-1',
			name: 'Indie One',
			...LOC,
			longitude: 3,
			items: [{ item_name: 'House Soup' }]
		},
		{
			id: 'indie-2',
			name: 'Indie Two',
			...LOC,
			longitude: 4,
			items: [{ item_name: 'House Salad' }]
		}
	]);
	// insertLocations names an inline-items private menu `pm-<location id>`.
	const indieItem = (await getMenuWithItems(db, 'pm-indie-1'))?.items[0];
	if (!indieItem) throw new Error('seed: expected an item on pm-indie-1');
	return { indieItemId: indieItem.id };
}

// ---------------------------------------------------------------------------
// update_items menu moves (assertItemMenuMoves)
// ---------------------------------------------------------------------------

test('item move to a nonexistent menu is rejected with a clear error', async () => {
	const db = freshDb();
	await seed(db);
	expect(assertItemMenuMoves(db, [{ id: 'item-a', menu_id: 'no-such-menu' }])).rejects.toThrow(
		'Item patch "item-a": no menu with id "no-such-menu"'
	);
});

test("item move to another venue's private menu is rejected", async () => {
	const db = freshDb();
	const { indieItemId } = await seed(db);
	// A shared chain item aimed at a venue's private menu…
	expect(assertItemMenuMoves(db, [{ id: 'item-a', menu_id: 'pm-indie-1' }])).rejects.toThrow(
		'Item patch "item-a": menu "pm-indie-1" is another venue\'s PRIVATE menu'
	);
	// …and one venue's item aimed at ANOTHER venue's private menu.
	expect(assertItemMenuMoves(db, [{ id: indieItemId, menu_id: 'pm-indie-2' }])).rejects.toThrow(
		`Item patch "${indieItemId}": menu "pm-indie-2" is another venue's PRIVATE menu`
	);
});

test("item move to another brand's shared menu is rejected", async () => {
	const db = freshDb();
	const { indieItemId } = await seed(db);
	expect(assertItemMenuMoves(db, [{ id: 'item-a', menu_id: 'menu-b' }])).rejects.toThrow(
		'would change its owning brand to "brand-b"'
	);
	// A private venue item cannot join a chain menu either.
	expect(assertItemMenuMoves(db, [{ id: indieItemId, menu_id: 'menu-a1' }])).rejects.toThrow(
		'would change its owning brand to "brand-a"'
	);
});

test('legitimate same-brand move passes and applies end to end', async () => {
	const db = freshDb();
	await seed(db);
	await assertItemMenuMoves(db, [{ id: 'item-a', menu_id: 'menu-a2' }]); // does not throw
	const { updatedIds } = await updateItems(db, [{ id: 'item-a', menu_id: 'menu-a2' }]);
	expect(updatedIds).toEqual(['item-a']);
	expect((await getItemById(db, 'item-a'))?.menu_id).toBe('menu-a2');
});

test('no-op moves and unknown item ids are skipped, not rejected', async () => {
	const db = freshDb();
	await seed(db);
	// Same-menu "move" and a missing item id (updateItems reports it in
	// not_found_ids) both pass validation, as does a patch without menu_id.
	await assertItemMenuMoves(db, [
		{ id: 'item-a', menu_id: 'menu-a1' },
		{ id: 'ghost', menu_id: 'menu-b' },
		{ id: 'item-b' }
	]);
});

// ---------------------------------------------------------------------------
// update_locations brand/menu patches (assertLocationRefPatches)
// ---------------------------------------------------------------------------

const storedVia = (db: D1Like) => (id: string) => getLocationById(db, id);

test('single-field brand detach on a chain branch is rejected', async () => {
	const db = freshDb();
	await seed(db);
	expect(
		assertLocationRefPatches(db, [{ id: 'branch-a', brand_id: null }], storedVia(db))
	).rejects.toThrow(
		'Patch for location "branch-a": brand_id: null would detach the brand but leave the ' +
			'location serving brand "brand-a"\'s shared menu "menu-a1"'
	);
});

test('cross-brand brand_id-only patch is rejected', async () => {
	const db = freshDb();
	await seed(db);
	// { brand_id: "brand-b" } alone would leave brand A's menu attached — the
	// exact cross-brand link assertBrandMenuRefs exists to prevent.
	expect(
		assertLocationRefPatches(db, [{ id: 'branch-a', brand_id: 'brand-b' }], storedVia(db))
	).rejects.toThrow('Patch for location "branch-a": Menu "menu-a1" belongs to brand "brand-a"');
});

test('menu_id-only patch validates against the stored brand', async () => {
	const db = freshDb();
	await seed(db);
	// Same-brand regional menu swap: effective pair (brand-a, menu-a2) is valid.
	await assertLocationRefPatches(db, [{ id: 'branch-a', menu_id: 'menu-a2' }], storedVia(db));
	// Cross-brand menu swap: effective pair (brand-a, menu-b) is rejected.
	expect(
		assertLocationRefPatches(db, [{ id: 'branch-a', menu_id: 'menu-b' }], storedVia(db))
	).rejects.toThrow('Patch for location "branch-a": Menu "menu-b" belongs to brand "brand-b"');
});

test('valid paired updates pass and apply end to end', async () => {
	const db = freshDb();
	await seed(db);
	const patches = [
		{ id: 'branch-a', brand_id: 'brand-b', menu_id: 'menu-b' }, // rebrand, paired
		{ id: 'branch-b', brand_id: null, menu_id: null } // full detach, paired
	];
	await assertLocationRefPatches(db, patches, storedVia(db)); // does not throw
	const { updatedIds } = await updateLocations(db, patches);
	expect(updatedIds.toSorted()).toEqual(['branch-a', 'branch-b']);
	const a = await getLocationById(db, 'branch-a');
	expect([a?.brand_id, a?.menu_id]).toEqual(['brand-b', 'menu-b']);
	const b = await getLocationById(db, 'branch-b');
	expect([b?.brand_id, b?.menu_id]).toEqual([null, null]);
});

test('no-op single-field patches and unknown ids pass validation', async () => {
	const db = freshDb();
	await seed(db);
	await assertLocationRefPatches(
		db,
		[
			// brand_id: null on an already-independent venue serving its private menu:
			// nothing changes, so the stored (null, pm-indie-1) shape is not re-judged.
			{ id: 'indie-1', brand_id: null },
			// Re-asserting the stored brand is a no-op too.
			{ id: 'branch-a', brand_id: 'brand-a' },
			// Unknown id: updateLocations reports it in not_found_ids.
			{ id: 'ghost', brand_id: null },
			// Patch without brand/menu fields is out of scope here.
			{ id: 'branch-b' }
		],
		storedVia(db)
	);
});
