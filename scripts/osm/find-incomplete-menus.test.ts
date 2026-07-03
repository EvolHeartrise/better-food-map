import { test, expect } from 'bun:test';
import { findIncompleteMenus } from './find-incomplete-menus';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride,
	setLocationClosed
} from '../../src/lib/server/db';
import { freshDb } from '../test-d1';

/** A minimal location insert; override per test. */
function loc(over: Record<string, unknown> = {}) {
	return {
		name: 'Venue',
		category: 'restaurant' as const,
		latitude: 49.28,
		longitude: -123.12,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

test('flags an independent venue with no items; leaves one with items alone', async () => {
	const db = freshDb();
	const [empty, stocked] = await insertLocations(db, [
		loc({ name: 'Empty Cafe' }),
		loc({ name: 'Stocked Cafe', items: [{ item_name: 'Coffee', price: 3 }] })
	]);

	const res = await findIncompleteMenus(db);
	expect(res.locations.map((l) => l.id)).toEqual([empty]);
	expect(res.locations[0].item_count).toBe(0);
	expect(res.locations[0].name).toBe('Empty Cafe');
	// The derived display address rides along for the work-list.
	expect(res.locations[0].address).toBe('1 Test St, Vancouver, BC V6J 1M5');
	expect(res.total).toBe(1);
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(0);
	void stocked;
});

test('counts a chain branch against its shared menu (not flagged when the menu has items)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'ChainCo CA', currency: 'CAD' });
	await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Combo', price: 10 },
		{ menu_id: menuId, item_name: 'Fries', price: 4 }
	]);
	await insertLocations(db, [
		loc({ name: 'ChainCo', category: 'fast_food', brand_id: brandId, menu_id: menuId })
	]);

	// The branch owns no private items but serves a 2-item shared menu → not flagged.
	expect((await findIncompleteMenus(db)).total).toBe(0);
});

test('a branch whose only shared items are all overridden-unavailable is effectively empty', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'ChainCo CA' });
	const [onlyItem] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Combo', price: 10 }
	]);
	const [branch] = await insertLocations(db, [
		loc({ name: 'ChainCo', category: 'fast_food', brand_id: brandId, menu_id: menuId })
	]);

	// Before overriding: the branch serves the one shared item → not flagged.
	expect((await findIncompleteMenus(db)).total).toBe(0);

	// Override the only item to unavailable at this branch → effective count 0.
	await setLocationItemOverride(db, branch, onlyItem, { available: false });
	const res = await findIncompleteMenus(db);
	expect(res.locations.map((l) => l.id)).toEqual([branch]);
	expect(res.locations[0].item_count).toBe(0);
	expect(res.locations[0].menu_id).toBe(menuId);
	expect(res.locations[0].brand_id).toBe(brandId);

	// A price-only override (available left to inherit) does NOT reduce the count.
	await setLocationItemOverride(db, branch, onlyItem, { available: null, price: 8 });
	expect((await findIncompleteMenus(db)).total).toBe(0);
});

test('min_items catches thin menus and counts effective items', async () => {
	const db = freshDb();
	const [thin] = await insertLocations(db, [
		loc({ name: 'Thin', items: [{ item_name: 'Only', price: 5 }] }),
		loc({ name: 'Full', items: [{ item_name: 'A' }, { item_name: 'B' }, { item_name: 'C' }] })
	]);

	// Default threshold (1) flags neither (both have ≥1 item).
	expect((await findIncompleteMenus(db)).total).toBe(0);

	// min_items: 2 flags only the 1-item "Thin" venue.
	const res = await findIncompleteMenus(db, { min_items: 2 });
	expect(res.locations.map((l) => l.id)).toEqual([thin]);
	expect(res.locations[0].item_count).toBe(1);
	expect(res.min_items).toBe(2);
});

test('excludes closed locations', async () => {
	const db = freshDb();
	const [closedEmpty] = await insertLocations(db, [loc({ name: 'Closed Empty' })]);
	await setLocationClosed(db, closedEmpty, Date.now(), 'closed for test');
	// The only empty venue is closed → nothing to flag (closed venues are hidden anyway).
	expect((await findIncompleteMenus(db)).total).toBe(0);
});

test('orders worst-first (0 items, then ascending count, then name) and honours limit/additional', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({ name: 'Zed Empty' }), // 0 items
		loc({ name: 'Alpha Empty' }), // 0 items
		loc({ name: 'One Item', items: [{ item_name: 'X' }] }), // 1 item
		loc({ name: 'Two Item', items: [{ item_name: 'X' }, { item_name: 'Y' }] }) // 2 items
	]);

	// min_items 3 flags all four; 0-item pair leads (name-ordered within a tie), then 1, then 2.
	const res = await findIncompleteMenus(db, { min_items: 3 });
	expect(res.locations.map((l) => l.name)).toEqual([
		'Alpha Empty',
		'Zed Empty',
		'One Item',
		'Two Item'
	]);
	expect(res.locations.map((l) => l.item_count)).toEqual([0, 0, 1, 2]);
	expect(res.total).toBe(4);

	// limit caps the returned list; additional counts the remainder.
	const capped = await findIncompleteMenus(db, { min_items: 3, limit: 2 });
	expect(capped.locations.map((l) => l.name)).toEqual(['Alpha Empty', 'Zed Empty']);
	expect(capped.returned).toBe(2);
	expect(capped.total).toBe(4);
	expect(capped.additional).toBe(2);
});
