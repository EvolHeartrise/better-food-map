/// <reference types="bun-types" />
// Tests the db-layer behaviour behind the MCP tool improvements:
//   * per-menu currency (stored on the menu, attached to every item on read)
//   * set_location_item_override partial-patch semantics
//   * add_sources append (vs the wholesale sources replace)
//   * coordinate-exact location de-dup + same-name brand/menu lookup
//   * item name-collision detection
// All run against the real migration schema via the in-memory D1 adapter.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	getMenuById,
	getMenus,
	getMenuWithItems,
	getItemById,
	getFoodByLocation,
	getLocationById,
	setLocationItemOverride,
	deleteLocationItemOverride,
	getLocationItemOverrides,
	updateItem,
	updateItems,
	updateMenu,
	updateLocations,
	deleteItem,
	setLocationClosed,
	countLocations,
	currentVerificationDate,
	existingLocationsAtCoords,
	coordinateKey,
	findBrandIdsByName,
	findMenuIdsByName,
	itemNameCollisions,
	type D1Like
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

/** Force a menu's freshness date into the past so a later write's auto-stamp is observable. */
async function staleMenu(db: D1Like, menuId: string) {
	await db.prepare(`UPDATE menus SET last_verified = '2000-01-01' WHERE id = ?`).bind(menuId).run();
}

async function menuDate(db: D1Like, menuId: string) {
	return (await getMenuById(db, menuId))?.last_verified;
}

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

// --- currency ---------------------------------------------------------------

test('menu currency is stored and attached to every item on read', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Subway', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'Subway UK',
		region: 'GB',
		currency: 'GBP'
	});
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Sub', price: 5 }]);

	const menu = await getMenuWithItems(db, menuId);
	expect(menu?.currency).toBe('GBP');
	expect(menu?.items[0]?.currency).toBe('GBP');

	const item = await getItemById(db, itemId);
	expect(item?.currency).toBe('GBP');
});

test('menu currency defaults to CAD when not given', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Tims', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Tims CA' });
	expect((await getMenuById(db, menuId))?.currency).toBe('CAD');
});

test('insertFoods sets the auto-created private menu currency', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation({ name: 'US Cafe', country: 'US' })]);
	await insertFoods(db, [{ location_id: locId, item_name: 'Coffee', price: 3 }], 'USD');
	const items = await getFoodByLocation(db, locId);
	expect(items[0]?.currency).toBe('USD');
});

test('insertLocations inline items use the location currency', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [
		indieLocation({ name: 'EU Spot', currency: 'EUR', items: [{ item_name: 'Plat', price: 12 }] })
	]);
	const items = await getFoodByLocation(db, locId);
	expect(items[0]?.currency).toBe('EUR');
});

// --- last_verified auto-stamp ----------------------------------------------
// last_verified is never an agent parameter: it is stamped to today whenever data
// flows into a menu via any write. Each case stales the menu first, then asserts
// the write refreshed it back to today.

test('insertMenu stamps last_verified to today', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('updateMenu refreshes last_verified on any edit (incl. sources-only)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });

	await staleMenu(db, menuId);
	await updateMenu(db, menuId, { region: 'CA' });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	// A sources-only edit (no scalar columns) still marks the menu fresh.
	await staleMenu(db, menuId);
	await updateMenu(db, menuId, { addSources: [{ url: 'https://m', label: null }] });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('adding items refreshes the parent menu (create_items, both paths)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	await staleMenu(db, menuId);
	await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Sub', price: 5 }]);
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	// insertFoods onto an EXISTING private menu re-stamps it too.
	const [locId] = await insertLocations(db, [
		indieLocation({ items: [{ item_name: 'Seed', price: 1 }] })
	]);
	const privateMenuId = (await getLocationById(db, locId))?.menu_id as string;
	await staleMenu(db, privateMenuId);
	await insertFoods(db, [{ location_id: locId, item_name: 'Coffee', price: 3 }]);
	expect(await menuDate(db, privateMenuId)).toBe(currentVerificationDate());
});

test('editing and deleting items refresh the parent menu', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	const [a, b] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'A', price: 1 },
		{ menu_id: menuId, item_name: 'B', price: 2 }
	]);

	await staleMenu(db, menuId);
	await updateItem(db, a, { price: 9 });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	await staleMenu(db, menuId);
	await updateItems(db, [{ id: b, price: 8 }]);
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	await staleMenu(db, menuId);
	await deleteItem(db, b);
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('per-location overrides refresh the parent menu', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'KFC', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'KFC CA' });
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Bucket', price: 20 }]);
	const [locId] = await insertLocations(db, [
		indieLocation({ name: 'KFC Branch', category: 'fast_food', brand_id: brandId, menu_id: menuId })
	]);

	await staleMenu(db, menuId);
	await setLocationItemOverride(db, locId, itemId, { price: 18 });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	await staleMenu(db, menuId);
	await deleteLocationItemOverride(db, locId, itemId);
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

// --- set_location_item_override partial patch -------------------------------

test('setLocationItemOverride is a partial patch (omitted field is preserved)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'KFC', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'KFC CA' });
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Bucket', price: 20 }]);
	const [locId] = await insertLocations(db, [
		indieLocation({ name: 'KFC Branch', category: 'fast_food', brand_id: brandId, menu_id: menuId })
	]);

	// Set the price only.
	await setLocationItemOverride(db, locId, itemId, { price: 18 });
	// Now set availability only — the previously-set price must survive.
	const merged = await setLocationItemOverride(db, locId, itemId, { available: false });
	expect(merged).toEqual({ available: false, price: 18 });
	expect(await getLocationItemOverrides(db, locId)).toEqual([
		{ location_id: locId, item_id: itemId, available: false, price: 18 }
	]);

	// An explicit null resets just that field to inherit; the other is kept.
	const reset = await setLocationItemOverride(db, locId, itemId, { price: null });
	expect(reset).toEqual({ available: false, price: null });
});

// --- add_sources append -----------------------------------------------------

test('updateItem add_sources appends and de-dupes; sources replaces', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [itemId] = await insertFoods(db, [
		{ location_id: locId, item_name: 'X', sources: [{ url: 'https://a', label: null }] }
	]);

	await updateItem(db, itemId, { addSources: [{ url: 'https://b', label: 'B' }] });
	expect((await getItemById(db, itemId))?.sources.map((s) => s.url)).toEqual([
		'https://a',
		'https://b'
	]);

	// Re-appending an existing url is a no-op (de-duped by url).
	await updateItem(db, itemId, { addSources: [{ url: 'https://b', label: 'B' }] });
	expect((await getItemById(db, itemId))?.sources).toHaveLength(2);

	// `sources` replaces the whole set.
	await updateItem(db, itemId, { sources: [{ url: 'https://c', label: null }] });
	expect((await getItemById(db, itemId))?.sources.map((s) => s.url)).toEqual(['https://c']);
});

test('updateItems applies a batch atomically and reports not_found_ids', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [a, b] = await insertFoods(db, [
		{ location_id: locId, item_name: 'A', price: 1 },
		{ location_id: locId, item_name: 'B', price: 2, tags: ['vegan'] }
	]);

	const { updatedIds, notFoundIds } = await updateItems(db, [
		{ id: a, price: 9, item_name: 'A2' },
		{ id: b, tags: ['vegetarian', 'halal'] },
		{ id: 'missing-id', price: 5 }
	]);

	expect(updatedIds.toSorted()).toEqual([a, b].toSorted());
	expect(notFoundIds).toEqual(['missing-id']);

	const itemA = await getItemById(db, a);
	expect(itemA?.item_name).toBe('A2');
	expect(itemA?.price).toBe(9);

	// `tags` replaces the whole dietary/course set for that item.
	const itemB = await getItemById(db, b);
	expect(itemB?.tags.map((t) => t.id).toSorted()).toEqual(['halal', 'vegetarian']);
});

test('updateMenu and updateLocations add_sources append', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'M',
		sources: [{ url: 'https://m1', label: null }]
	});
	await updateMenu(db, menuId, { addSources: [{ url: 'https://m2', label: null }] });
	expect((await getMenuById(db, menuId))?.sources.map((s) => s.url)).toEqual([
		'https://m1',
		'https://m2'
	]);

	const [locId] = await insertLocations(db, [
		indieLocation({ sources: [{ url: 'https://l1', label: null }] })
	]);
	await updateLocations(db, [{ id: locId, addSources: [{ url: 'https://l2', label: null }] }]);
	expect((await getLocationById(db, locId))?.sources.map((s) => s.url)).toEqual([
		'https://l1',
		'https://l2'
	]);
});

// --- duplicate / collision detection ---------------------------------------

test('existingLocationsAtCoords matches coordinate-exact locations only', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [
		indieLocation({ latitude: 49.1234567, longitude: -123.7654321 })
	]);
	const map = await existingLocationsAtCoords(db, [
		{ latitude: 49.1234567, longitude: -123.7654321 },
		{ latitude: 1, longitude: 2 }
	]);
	expect(map.get(coordinateKey(49.1234567, -123.7654321))?.id).toBe(locId);
	expect(map.has(coordinateKey(1, 2))).toBe(false);
});

test('findBrandIdsByName / findMenuIdsByName are case-insensitive', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: "McDonald's", website: null, logo_url: null });
	expect(await findBrandIdsByName(db, "mcdonald's")).toEqual([brandId]);
	expect(await findBrandIdsByName(db, 'Wendys')).toEqual([]);

	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Canada' });
	expect(await findMenuIdsByName(db, brandId, 'canada')).toEqual([menuId]);
	expect(await findMenuIdsByName(db, brandId, 'UK')).toEqual([]);
});

test('itemNameCollisions reports existing names case-insensitively', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	const [bucketId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Bucket' }]);

	expect(await itemNameCollisions(db, menuId, ['bucket', 'Fries'])).toEqual([
		{ item_name: 'bucket', existing_ids: [bucketId] }
	]);
	expect(await itemNameCollisions(db, menuId, [])).toEqual([]);
});

// --- chain-audit reads (menu location_count, countLocations) ----------------

test('getMenus counts open branches per menu; countLocations filters by brand', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'ChainCo Canada',
		region: 'CA',
		currency: 'CAD'
	});
	const [a, b] = await insertLocations(db, [
		indieLocation({ name: 'ChainCo', brand_id: brandId, menu_id: menuId }),
		indieLocation({
			name: 'ChainCo',
			brand_id: brandId,
			menu_id: menuId,
			latitude: 50.1,
			longitude: -120.5
		})
	]);
	await insertLocations(db, [indieLocation({ latitude: 51.0, longitude: -114.0 })]);

	const menus = await getMenus(db, brandId);
	expect(menus[0].location_count).toBe(2);
	expect(await countLocations(db, { brandId })).toBe(2);
	expect(await countLocations(db)).toBe(3);

	// A closed branch drops out of both counts.
	await setLocationClosed(db, b, Date.now(), 'closed for test');
	expect((await getMenus(db, brandId))[0].location_count).toBe(1);
	expect(await countLocations(db, { brandId })).toBe(1);
	void a;
});
