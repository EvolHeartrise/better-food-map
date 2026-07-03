/// <reference types="bun-types" />
// Tests createChainBundle — the create_chain tool's core: create a brand, one menu
// under it, and that menu's items in one call, preserving the individual tools'
// id-idempotency and same-name-warning semantics. Runs against the real migration
// schema via the in-memory D1 adapter.

import { test, expect } from 'bun:test';
import {
	getBrandById,
	getBrands,
	getMenuWithItems,
	getMenus,
	type MenuWithItems
} from '../../src/lib/server/db';
import { freshDb } from '../test-d1';
import { createChainBundle } from './create-chain';

function present<T>(value: T | null): T {
	if (value === null) throw new Error('expected a non-null read');
	return value;
}

test('a full bundle creates the brand, its menu and the menu items', async () => {
	const db = freshDb();
	const res = await createChainBundle(db, {
		brand: { name: 'Subway', website: 'https://subway.com' },
		menu: { name: 'Subway CA', region: 'CA', currency: 'CAD' },
		items: [
			{ item_name: 'Veggie Sub', price: 6, tags: ['vegetarian'] },
			{ item_name: 'Turkey Sub', price: 7 }
		]
	});

	expect(res.created_items).toBe(2);
	expect(res.item_ids).toHaveLength(2);
	expect(res.already_existed).toBeUndefined();
	expect(res.warnings).toBeUndefined();

	const brand = present(await getBrandById(db, res.brand_id));
	expect(brand.name).toBe('Subway');
	const menu: MenuWithItems = present(await getMenuWithItems(db, res.menu_id));
	expect(menu.brand_id).toBe(res.brand_id);
	expect(menu.currency).toBe('CAD');
	expect(menu.items.map((i) => i.item_name).toSorted()).toEqual(['Turkey Sub', 'Veggie Sub']);
	// The returned item_ids are the ids actually written.
	expect(menu.items.map((i) => i.id).toSorted()).toEqual(res.item_ids.toSorted());
});

test('empty items scaffolds just the brand + menu (add items later)', async () => {
	const db = freshDb();
	const res = await createChainBundle(db, {
		brand: { name: 'Tims' },
		menu: { name: 'Tims CA' },
		items: []
	});

	expect(res.created_items).toBe(0);
	expect(res.item_ids).toEqual([]);
	expect(await getBrandById(db, res.brand_id)).not.toBeNull();
	const menu = present(await getMenuWithItems(db, res.menu_id));
	expect(menu.items).toEqual([]);
});

test('explicit existing brand/menu ids are no-ops reported in already_existed', async () => {
	const db = freshDb();
	await createChainBundle(db, {
		brand: { id: 'brand-1', name: 'KFC' },
		menu: { id: 'menu-1', name: 'KFC CA' },
		items: [{ item_name: 'Bucket', price: 20 }]
	});

	const brandsBefore = (await getBrands(db)).length;
	const menusBefore = (await getMenus(db, 'brand-1')).length;

	const again = await createChainBundle(db, {
		brand: { id: 'brand-1', name: 'KFC' },
		menu: { id: 'menu-1', name: 'KFC CA' },
		items: []
	});
	expect(again.brand_id).toBe('brand-1');
	expect(again.menu_id).toBe('menu-1');
	expect(again.already_existed).toEqual({ brand: true, menu: true });
	expect(again.created_items).toBe(0);
	// Nothing was duplicated.
	expect((await getBrands(db)).length).toBe(brandsBefore);
	expect((await getMenus(db, 'brand-1')).length).toBe(menusBefore);
	// The original item survived (menu untouched).
	const menu = present(await getMenuWithItems(db, 'menu-1'));
	expect(menu.items.map((i) => i.item_name)).toEqual(['Bucket']);
});

test('a same-name brand and a same-name menu both produce warnings', async () => {
	const db = freshDb();
	// Seed an existing brand (b-existing) with a menu named "Duplo Regional".
	await createChainBundle(db, {
		brand: { id: 'b-existing', name: 'Duplo' },
		menu: { name: 'Duplo Regional' },
		items: []
	});

	// A NEW brand of the same name warns (and is still created).
	const dupBrand = await createChainBundle(db, {
		brand: { name: 'Duplo' },
		menu: { name: 'Fresh Menu' },
		items: []
	});
	expect(dupBrand.already_existed).toBeUndefined();
	expect(dupBrand.warnings?.some((w) => w.includes('brand named "Duplo"'))).toBe(true);

	// Reusing the existing brand with a same-name menu warns on the MENU.
	const dupMenu = await createChainBundle(db, {
		brand: { id: 'b-existing', name: 'Duplo' },
		menu: { name: 'Duplo Regional' },
		items: []
	});
	expect(dupMenu.already_existed).toEqual({ brand: true, menu: false });
	expect(dupMenu.warnings?.some((w) => w.includes('menu named "Duplo Regional"'))).toBe(true);
});
