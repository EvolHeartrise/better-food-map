/// <reference types="bun-types" />
// Tests assertBrandMenuRefs — the guard every location↔chain link goes through
// (create_locations, update_locations, import_chain) — and countMenuItems, which
// backs import_chain's empty-menu prerequisite check. Covers issue #85: a private
// venue menu (brand_id NULL) must never be attachable, and a shared menu is only
// attachable together with its own brand.

import { test, expect } from 'bun:test';
import {
	assertBrandMenuRefs,
	countMenuItems,
	insertBrand,
	insertMenu,
	insertMenuItems,
	insertLocations,
	insertFoods,
	getLocationById
} from '../src/lib/server/db-write';
import { freshDb } from './test-d1';

/** A minimal independent-venue insert; override fields as needed per test. */
function indieLocation(over: Record<string, unknown> = {}) {
	return {
		name: 'Indie',
		category: 'cafe' as const,
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

/** A brand + shared menu pair, returning both ids. */
async function chainFixture(db: ReturnType<typeof freshDb>, name = 'Subway') {
	const brandId = await insertBrand(db, { name, website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: `${name} CA`, region: 'CA' });
	return { brandId, menuId };
}

test('accepts a shared menu passed with its own brand', async () => {
	const db = freshDb();
	const { brandId, menuId } = await chainFixture(db);
	expect(assertBrandMenuRefs(db, brandId, menuId)).resolves.toBeUndefined();
});

test('accepts detaching and brand-only references', async () => {
	const db = freshDb();
	const { brandId } = await chainFixture(db);
	expect(assertBrandMenuRefs(db, null, null)).resolves.toBeUndefined();
	expect(assertBrandMenuRefs(db, undefined, undefined)).resolves.toBeUndefined();
	expect(assertBrandMenuRefs(db, brandId, undefined)).resolves.toBeUndefined();
});

test('rejects a missing brand or menu', async () => {
	const db = freshDb();
	const { brandId, menuId } = await chainFixture(db);
	expect(assertBrandMenuRefs(db, 'nope', menuId)).rejects.toThrow('No brand with id');
	expect(assertBrandMenuRefs(db, brandId, 'nope')).rejects.toThrow('No menu with id');
});

test("rejects an independent venue's private menu (issue #85)", async () => {
	const db = freshDb();
	const { brandId } = await chainFixture(db);
	const [locId] = await insertLocations(db, [indieLocation()]);
	await insertFoods(db, [{ location_id: locId, item_name: 'Coffee', price: 3 }]);
	const privateMenuId = (await getLocationById(db, locId))?.menu_id;
	expect(privateMenuId).toBeTruthy();
	// Rejected both with a brand and without — a private menu is never attachable.
	expect(assertBrandMenuRefs(db, brandId, privateMenuId)).rejects.toThrow('private menu');
	expect(assertBrandMenuRefs(db, undefined, privateMenuId)).rejects.toThrow('private menu');
});

test('rejects a shared menu passed without its brand (cross-brand escape, issue #85)', async () => {
	const db = freshDb();
	const { menuId } = await chainFixture(db);
	expect(assertBrandMenuRefs(db, undefined, menuId)).rejects.toThrow(
		'pass that brand_id together with menu_id'
	);
	expect(assertBrandMenuRefs(db, null, menuId)).rejects.toThrow(
		'pass that brand_id together with menu_id'
	);
});

test("rejects another brand's shared menu", async () => {
	const db = freshDb();
	const { menuId } = await chainFixture(db, 'Subway');
	const { brandId: otherBrand } = await chainFixture(db, 'Quiznos');
	expect(assertBrandMenuRefs(db, otherBrand, menuId)).rejects.toThrow('belongs to brand');
});

test('countMenuItems counts the menu items (0 for empty or missing menus)', async () => {
	const db = freshDb();
	const { menuId } = await chainFixture(db);
	expect(await countMenuItems(db, menuId)).toBe(0);
	expect(await countMenuItems(db, 'nope')).toBe(0);
	await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Sub', price: 5 },
		{ menu_id: menuId, item_name: 'Cookie', price: 2 }
	]);
	expect(await countMenuItems(db, menuId)).toBe(2);
});
