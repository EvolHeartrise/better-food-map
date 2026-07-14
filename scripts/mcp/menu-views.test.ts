/// <reference types="bun-types" />
// Tests the pure per-`view` menu projections that back get_menu (default "names")
// and get_location (default "full"). Exercised against the real migration schema
// via the in-memory D1 adapter, since itemNameView/menuItemsSummary operate on the
// same {@link Item} shape getMenuWithItems / getFoodByLocation return.

import { test, expect } from 'bun:test';
import { type D1Like, type MenuWithItems } from '../../src/lib/server/db';
import {
	insertBrand,
	insertMenu,
	insertMenuItems,
	getMenuWithItems
} from '../../src/lib/server/db-write';
import { freshDb } from '../test-d1';
import { itemNameView, menuItemsSummary } from './menu-views';

function present<T>(value: T | null): T {
	if (value === null) throw new Error('expected a non-null read');
	return value;
}

/** A menu with one fully-detailed item (price, a required + an optional tag)
 *  and one bare item (no price, no tags). Provenance is menu-level, not per item. */
async function seedMenu(db: D1Like): Promise<MenuWithItems> {
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'ChainCo CA',
		currency: 'CAD',
		sources: [{ url: 'https://x', label: null }]
	});
	await insertMenuItems(db, [
		{
			menu_id: menuId,
			item_name: 'Vegan Combo',
			description: 'A combo',
			price: 10,
			tags: ['vegan'],
			optionalTags: ['gluten_friendly']
		},
		{ menu_id: menuId, item_name: 'Plain Side' }
	]);
	return present(await getMenuWithItems(db, menuId));
}

test('itemNameView projects id/item_name/price/tag-ids, flagging optional tags', async () => {
	const db = freshDb();
	const menu = await seedMenu(db);
	const combo = present(menu.items.find((i) => i.item_name === 'Vegan Combo') ?? null);

	const view = itemNameView(combo);
	expect(view.id).toBe(combo.id);
	expect(view.item_name).toBe('Vegan Combo');
	expect(view.price).toBe(10);
	expect(view.tags.toSorted()).toEqual(['gluten_friendly (optional)', 'vegan']);
	// The lean shape carries NO description / sources keys (that is the point of "names").
	expect('description' in view).toBe(false);
	expect('sources' in view).toBe(false);
});

test('menuItemsSummary counts items, prices and a per-tag histogram', async () => {
	const db = freshDb();
	const menu = await seedMenu(db);

	const summary = menuItemsSummary(menu.items);
	expect(summary.item_count).toBe(2);
	expect(summary.items_with_price).toBe(1); // only Vegan Combo has a price
	// Both a required (vegan) and an optional (gluten_friendly) tag are counted.
	expect(summary.tag_counts).toEqual({ vegan: 1, gluten_friendly: 1 });
});

test('an empty menu summarizes to all-zero counts and an empty histogram', () => {
	const summary = menuItemsSummary([]);
	expect(summary).toEqual({
		item_count: 0,
		items_with_price: 0,
		tag_counts: {}
	});
});
