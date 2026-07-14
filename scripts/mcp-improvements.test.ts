/// <reference types="bun-types" />
// Tests the db-layer behaviour behind the MCP tool improvements:
//   * per-menu currency (stored on the menu, attached to every item on read)
//   * set_location_item_override partial-patch semantics
//   * add_sources append (vs the wholesale sources replace)
//   * coordinate-exact location de-dup + same-name brand/menu lookup
//   * item name-collision detection
// All run against the real migration schema via the in-memory D1 adapter.

import { test, expect } from 'bun:test';
import { type D1Like } from '../src/lib/server/db';
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
	updateItems,
	updateMenu,
	deleteItem,
	setLocationClosed,
	countLocations,
	currentVerificationDate,
	existingLocationsAtCoords,
	coordinateKey,
	findBrandIdsByName,
	findMenuIdsByName,
	itemNameCollisions
} from '../src/lib/server/db-write';
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
	const brandId = await insertBrand(db, {
		name: 'Subway',
		website: null,
		logo_url: null
	});
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
	const brandId = await insertBrand(db, {
		name: 'Tims',
		website: null,
		logo_url: null
	});
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
		indieLocation({
			name: 'EU Spot',
			currency: 'EUR',
			items: [{ item_name: 'Plat', price: 12 }]
		})
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
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('updateMenu refreshes last_verified on any edit (incl. sources-only)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });

	await staleMenu(db, menuId);
	await updateMenu(db, menuId, { region: 'CA' });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());

	// A sources-only edit (no scalar columns) still marks the menu fresh.
	await staleMenu(db, menuId);
	await updateMenu(db, menuId, {
		addSources: [{ url: 'https://m', label: null }]
	});
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('updateMenu stampVerified: false banks the edit without refreshing last_verified', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });

	// An incomplete refresh banks its discovered page inventory: notes change,
	// the staleness date must not.
	await staleMenu(db, menuId);
	const updated = await updateMenu(db, menuId, {
		refresh_notes: 'pages: /menu, /menu/drinks (never extracted)',
		stampVerified: false
	});
	expect(updated?.refresh_notes).toBe('pages: /menu, /menu/drinks (never extracted)');
	expect(await menuDate(db, menuId)).toBe('2000-01-01');

	// A notes-only no-stamp edit must not leave the row untouched by accident:
	// the same call WITH stamping (default) refreshes the date.
	await updateMenu(db, menuId, { refresh_notes: 'pages: all extracted' });
	expect(await menuDate(db, menuId)).toBe(currentVerificationDate());
});

test('adding items refreshes the parent menu (create_items, both paths)', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
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
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	const [a, b] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'A', price: 1 },
		{ menu_id: menuId, item_name: 'B', price: 2 }
	]);

	await staleMenu(db, menuId);
	await updateItems(db, [{ id: a, price: 9 }]);
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
	const brandId = await insertBrand(db, {
		name: 'KFC',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'KFC CA' });
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Bucket', price: 20 }]);
	const [locId] = await insertLocations(db, [
		indieLocation({
			name: 'KFC Branch',
			category: 'fast_food',
			brand_id: brandId,
			menu_id: menuId
		})
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
	const brandId = await insertBrand(db, {
		name: 'KFC',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'KFC CA' });
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Bucket', price: 20 }]);
	const [locId] = await insertLocations(db, [
		indieLocation({
			name: 'KFC Branch',
			category: 'fast_food',
			brand_id: brandId,
			menu_id: menuId
		})
	]);

	// Set the price only.
	await setLocationItemOverride(db, locId, itemId, { price: 18 });
	// Now set availability only — the previously-set price must survive.
	const merged = await setLocationItemOverride(db, locId, itemId, {
		available: false
	});
	expect(merged).toEqual({ available: false, price: 18 });
	expect(await getLocationItemOverrides(db, locId)).toEqual([
		{ location_id: locId, item_id: itemId, available: false, price: 18 }
	]);

	// An explicit null resets just that field to inherit; the other is kept.
	const reset = await setLocationItemOverride(db, locId, itemId, {
		price: null
	});
	expect(reset).toEqual({ available: false, price: null });
});

// --- add_sources append -----------------------------------------------------

test('updateMenu add_sources appends and de-dupes; sources replaces', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'M',
		sources: [{ url: 'https://a', label: null }]
	});

	await updateMenu(db, menuId, {
		addSources: [{ url: 'https://b', label: 'B' }]
	});
	expect((await getMenuById(db, menuId))?.sources.map((s) => s.url)).toEqual([
		'https://a',
		'https://b'
	]);

	// Re-appending an existing url is a no-op (de-duped by url).
	await updateMenu(db, menuId, {
		addSources: [{ url: 'https://b', label: 'B' }]
	});
	expect((await getMenuById(db, menuId))?.sources).toHaveLength(2);

	// `sources` replaces the whole set.
	await updateMenu(db, menuId, {
		sources: [{ url: 'https://c', label: null }]
	});
	expect((await getMenuById(db, menuId))?.sources.map((s) => s.url)).toEqual(['https://c']);
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

test('updateItems tag patches are per-set: one set never wipes the other', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [id] = await insertFoods(db, [
		{
			location_id: locId,
			item_name: 'Thali',
			tags: ['halal'],
			optionalTags: ['gluten_friendly']
		}
	]);

	const byId = async () =>
		new Map(((await getItemById(db, id))?.tags ?? []).map((t) => [t.id, t.optional]));

	// Patching only optional_tags leaves the required (source-asserted) set intact.
	await updateItems(db, [{ id, optionalTags: ['vegan'] }]);
	expect(await byId()).toEqual(
		new Map([
			['halal', false],
			['vegan', true]
		])
	);

	// Patching only tags leaves the optional set intact.
	await updateItems(db, [{ id, tags: ['nut_free'] }]);
	expect(await byId()).toEqual(
		new Map([
			['nut_free', false],
			['vegan', true]
		])
	);

	// An empty array clears just its own set.
	await updateItems(db, [{ id, optionalTags: [] }]);
	expect(await byId()).toEqual(new Map([['nut_free', false]]));

	// A tag named in the patch moves scope: required nut_free becomes optional.
	await updateItems(db, [{ id, optionalTags: ['nut_free'] }]);
	expect(await byId()).toEqual(new Map([['nut_free', true]]));

	// ...and back: optional nut_free asserted required by a tags-only patch.
	await updateItems(db, [{ id, tags: ['nut_free', 'halal'] }]);
	expect(await byId()).toEqual(
		new Map([
			['nut_free', false],
			['halal', false]
		])
	);

	// Providing both sets is still a full replace.
	await updateItems(db, [{ id, tags: ['vegetarian'], optionalTags: ['gluten_friendly'] }]);
	expect(await byId()).toEqual(
		new Map([
			['vegetarian', false],
			['gluten_friendly', true]
		])
	);
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
	const brandId = await insertBrand(db, {
		name: "McDonald's",
		website: null,
		logo_url: null
	});
	expect(await findBrandIdsByName(db, "mcdonald's")).toEqual([brandId]);
	expect(await findBrandIdsByName(db, 'Wendys')).toEqual([]);

	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Canada' });
	expect(await findMenuIdsByName(db, brandId, 'canada')).toEqual([menuId]);
	expect(await findMenuIdsByName(db, brandId, 'UK')).toEqual([]);
});

test('itemNameCollisions reports existing names case-insensitively', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'B',
		website: null,
		logo_url: null
	});
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
	const brandId = await insertBrand(db, {
		name: 'ChainCo',
		website: null,
		logo_url: null
	});
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

test('menus bank refresh_notes: stored on create, patchable, clearable', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'ChainCo',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'ChainCo Canada',
		region: 'CA',
		refresh_notes: 'menu page is client-rendered; use https://chainco.example/api/menu'
	});
	expect((await getMenuById(db, menuId))?.refresh_notes).toBe(
		'menu page is client-rendered; use https://chainco.example/api/menu'
	);
	// Omitting the field on an unrelated patch leaves it untouched.
	await updateMenu(db, menuId, { name: 'ChainCo CA' });
	expect((await getMenuById(db, menuId))?.refresh_notes).toContain('client-rendered');
	// Patching replaces it; explicit null clears it.
	await updateMenu(db, menuId, { refresh_notes: 'use the v2 endpoint' });
	expect((await getMenuById(db, menuId))?.refresh_notes).toBe('use the v2 endpoint');
	await updateMenu(db, menuId, { refresh_notes: null });
	expect((await getMenuById(db, menuId))?.refresh_notes).toBeNull();
	// A menu created without notes reads null.
	const bareId = await insertMenu(db, {
		brand_id: brandId,
		name: 'Bare',
		region: 'CA'
	});
	expect((await getMenuById(db, bareId))?.refresh_notes).toBeNull();
});

test('updateItems merge ops edit tags without restating the set', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [id] = await insertFoods(db, [
		{
			location_id: locId,
			item_name: 'Burger',
			tags: ['vegan', 'food'],
			optionalTags: ['gluten_friendly']
		}
	]);

	const byId = async () =>
		new Map(((await getItemById(db, id))?.tags ?? []).map((t) => [t.id, t.optional]));

	// add_tags links one more required tag; everything else is untouched.
	await updateItems(db, [{ id, addTags: ['halal'] }]);
	expect(await byId()).toEqual(
		new Map([
			['vegan', false],
			['food', false],
			['halal', false],
			['gluten_friendly', true]
		])
	);

	// remove_tags unlinks from BOTH scopes without touching the rest.
	const { warnings } = await updateItems(db, [{ id, removeTags: ['halal', 'gluten_friendly'] }]);
	expect(warnings).toEqual([]); // merge-op removals are explicit, never warned
	expect(await byId()).toEqual(
		new Map([
			['vegan', false],
			['food', false]
		])
	);

	// add_optional_tags moves a required dietary tag to optional (explicit assertion wins)...
	await updateItems(db, [{ id, addOptionalTags: ['vegan'] }]);
	expect(await byId()).toEqual(
		new Map([
			['food', false],
			['vegan', true]
		])
	);

	// ...and add_tags moves it back to required.
	await updateItems(db, [{ id, addTags: ['vegan'] }]);
	expect(await byId()).toEqual(
		new Map([
			['food', false],
			['vegan', false]
		])
	);
});

test('updateItems merge ops enforce the course-tag invariants', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [id] = await insertFoods(db, [
		{ location_id: locId, item_name: 'Milkshake', tags: ['drink'] }
	]);

	// Removing the last course tag is rejected (nothing is written).
	expect(updateItems(db, [{ id, removeTags: ['drink'] }])).rejects.toThrow(/last course tag/);

	// Swapping the course tag in one patch is fine.
	await updateItems(db, [{ id, removeTags: ['drink'], addTags: ['dessert'] }]);
	expect(((await getItemById(db, id))?.tags ?? []).map((t) => t.id)).toEqual(['dessert']);

	// "food" cannot end up combined with dessert/drink via a merge add.
	expect(updateItems(db, [{ id, addTags: ['food'] }])).rejects.toThrow(/neither dessert nor drink/);

	// A course tag can never be linked optional.
	expect(updateItems(db, [{ id, addOptionalTags: ['drink'] }])).rejects.toThrow(
		/never be optional/
	);

	// Mixing replace sets and merge ops in one patch is rejected.
	expect(updateItems(db, [{ id, tags: ['food'], addTags: ['vegan'] }])).rejects.toThrow(/not both/);
});

test('updateItems warns when a replace-path patch drops a dietary tag', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [indieLocation()]);
	const [burger, salad] = await insertFoods(db, [
		{ location_id: locId, item_name: 'Vegan Burger', tags: ['vegan', 'food'] },
		{
			location_id: locId,
			item_name: 'Salad',
			tags: ['food'],
			optionalTags: ['gluten_friendly']
		}
	]);

	// The MeeT-on-Main failure mode: a footnote pass restates `tags` without the
	// dietary tag → the drop is applied (replace semantics) but WARNED.
	const res = await updateItems(db, [{ id: burger, tags: ['food'] }]);
	expect(res.warnings).toHaveLength(1);
	expect(res.warnings[0]).toContain(burger);
	expect(res.warnings[0]).toContain('vegan');
	expect(((await getItemById(db, burger))?.tags ?? []).map((t) => t.id)).toEqual(['food']);

	// Restating the set WITH the tag present does not warn; nor does a patch that
	// never touches tags, nor dropping an optional-set dietary tag that the patch
	// explicitly replaces with itself.
	await updateItems(db, [{ id: burger, tags: ['vegan', 'food'] }]);
	expect((await updateItems(db, [{ id: burger, price: 9 }])).warnings).toEqual([]);
	expect((await updateItems(db, [{ id: burger, tags: ['vegan', 'food'] }])).warnings).toEqual([]);

	// Dropping an OPTIONAL dietary tag by restating optional_tags also warns.
	const dropped = await updateItems(db, [{ id: salad, optionalTags: [] }]);
	expect(dropped.warnings).toHaveLength(1);
	expect(dropped.warnings[0]).toContain('gluten_friendly');

	// Replacing vegan with vegetarian+dairy_free is NOT a drop — the implication
	// closure already covered them, so nothing the filter matched is lost... but
	// replacing vegetarian/dairy_free coverage the other way IS: swapping vegan
	// out for vegetarian drops nothing the closure still covers.
	await updateItems(db, [{ id: burger, tags: ['vegan', 'food'] }]);
	const swap = await updateItems(db, [{ id: burger, tags: ['vegetarian', 'dairy_free', 'food'] }]);
	expect(swap.warnings).toHaveLength(1); // vegan itself was dropped — warned
	expect(swap.warnings[0]).toContain('vegan');

	// A tag moved across scopes in one patch (required -> optional) is not a drop.
	await updateItems(db, [{ id: burger, tags: ['vegan', 'food'] }]);
	const moved = await updateItems(db, [{ id: burger, tags: ['food'], optionalTags: ['vegan'] }]);
	expect(moved.warnings).toEqual([]);
});
