/// <reference types="bun-types" />
// Guards Change 3 (MCP structuredContent / outputSchema): every tool that
// advertises an `outputSchema` must actually be able to produce a result that
// VALIDATES against that same valibot schema — otherwise a strict client that
// checks structuredContent against the advertised schema would reject a valid
// response. The server imports these exact schemas (scripts/mcp/output-schemas.ts),
// so validating real handler-shaped results here means the advertised schema and
// the real output cannot silently drift.
//
// db-mcp-server.ts connects a stdio transport on import, so we can't import the
// handlers. Instead we rebuild each read tool's result from the SAME db helpers
// the handler uses (applying the handler's trivial projection), and construct
// representative write-result objects mirroring the handler return expressions.

import { test, expect } from 'bun:test';
import * as v from 'valibot';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride,
	getItemById,
	getMenuById,
	getMenuWithItems,
	getBrandById,
	getMenus,
	getLocationById,
	getFoodByLocation,
	getLocationItemOverrides,
	getLocationsWithTags,
	countLocations,
	type Item,
	type LocationWithTags,
	type D1Like
} from '../../src/lib/server/db';
import { freshDb } from '../test-d1';
import { findIncompleteMenus } from '../osm/find-incomplete-menus';
import { findHtmlEntities } from '../osm/find-html-entities';
import { findDuplicateLocations } from '../osm/find-duplicate-locations';
import { buildListLocationsPage } from './list-locations-page';
import {
	listLocationsOutput,
	getLocationOutput,
	getItemOutput,
	getMenuOutput,
	getBrandOutput,
	auditLocationsOutput,
	createLocationsOutput,
	updateLocationsOutput,
	createItemsOutput,
	updateItemsOutput,
	createChainOutput,
	deleteLocationsOutput
} from './output-schemas';
import { itemNameView, menuItemsSummary } from './menu-views';

// --- projections copied verbatim from the server handlers -------------------
// (itemWithinParent / projectLocationOverview live in db-mcp-server.ts, which we
// cannot import; these mirror them exactly.)

/** Unwraps a `T | null` read, failing the test loudly rather than asserting non-null. */
function present<T>(value: T | null): T {
	if (value === null) throw new Error('expected a non-null read');
	return value;
}

function itemWithinParent({ menu_id: _m, currency: _c, ...rest }: Item) {
	return rest;
}

function projectLocationOverview(loc: LocationWithTags) {
	return {
		id: loc.id,
		name: loc.name,
		category: loc.category,
		latitude: loc.latitude,
		longitude: loc.longitude,
		address: loc.address,
		phone: loc.phone,
		website: loc.website,
		brand_id: loc.brand_id,
		menu_id: loc.menu_id,
		tags: loc.tags.map((t) => t.id)
	};
}

/** Seeds a brand + shared menu with two tagged items, a chain branch (with an
 *  override) and an independent venue with its own item. Returns the ids. */
async function seedRich(db: D1Like) {
	const brandId = await insertBrand(db, {
		name: 'ChainCo',
		website: 'https://chainco.example',
		logo_url: null
	});
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'ChainCo CA',
		region: 'CA',
		currency: 'CAD',
		sources: [{ url: 'https://chainco.example/menu', label: 'Official menu' }]
	});
	const [combo, salad] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Vegan Combo', price: 10, tags: ['vegan'] },
		{ menu_id: menuId, item_name: 'Side Salad', price: 4, tags: ['vegetarian'] }
	]);
	const [branchId, indieId] = await insertLocations(db, [
		{
			name: 'ChainCo',
			category: 'fast_food',
			latitude: 49.28,
			longitude: -123.12,
			street: '1 Main St',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
			phone: '+1 604-555-0100',
			website: null,
			brand_id: brandId,
			menu_id: menuId
		},
		{
			name: 'Indie Bistro',
			category: 'restaurant',
			latitude: 49.29,
			longitude: -123.13,
			street: '2 Side St',
			city: 'Vancouver',
			region: 'BC',
			postcode: null,
			country: 'CA',
			phone: null,
			website: 'https://indie.example',
			menuSources: [{ url: 'https://indie.example/menu', label: 'Menu' }],
			items: [{ item_name: 'Coffee', price: 3, tags: ['vegan'] }]
		}
	]);
	await setLocationItemOverride(db, branchId, salad, { price: 5 });
	return { brandId, menuId, combo, salad, branchId, indieId };
}

test('get_item output validates against getItemOutput', async () => {
	const db = freshDb();
	const { combo } = await seedRich(db);
	const item = await getItemById(db, combo);
	expect(item).not.toBeNull();
	expect(() => v.parse(getItemOutput, item)).not.toThrow();
});

test('get_menu output validates in all three views', async () => {
	const db = freshDb();
	const { menuId } = await seedRich(db);
	const menu = present(await getMenuWithItems(db, menuId));

	// full view
	const full = { ...menu, items: menu.items.map(itemWithinParent) };
	expect(() => v.parse(getMenuOutput, full)).not.toThrow();

	// names view
	const names = {
		...menu,
		items: menu.items.map((it) => ({
			id: it.id,
			item_name: it.item_name,
			price: it.price,
			tags: it.tags.map((t) => (t.optional ? `${t.id} (optional)` : t.id))
		}))
	};
	expect(() => v.parse(getMenuOutput, names)).not.toThrow();

	// summary view
	const tagCounts: Record<string, number> = {};
	for (const it of menu.items)
		for (const t of it.tags) tagCounts[t.id] = (tagCounts[t.id] ?? 0) + 1;
	const { items: _items, ...meta } = menu;
	const summary = {
		...meta,
		item_count: menu.items.length,
		items_with_price: menu.items.filter((i) => i.price !== null).length,
		tag_counts: tagCounts
	};
	expect(() => v.parse(getMenuOutput, summary)).not.toThrow();
});

test('get_brand output validates against getBrandOutput', async () => {
	const db = freshDb();
	const { brandId } = await seedRich(db);
	const brand = present(await getBrandById(db, brandId));
	const result = { ...brand, menus: await getMenus(db, brandId) };
	expect(() => v.parse(getBrandOutput, result)).not.toThrow();
});

test('get_location output validates for both a chain branch and an independent venue', async () => {
	const db = freshDb();
	const { branchId, indieId } = await seedRich(db);

	for (const id of [branchId, indieId]) {
		const location = present(await getLocationById(db, id));
		const [menu, overrides, menuRow] = await Promise.all([
			getFoodByLocation(db, id),
			getLocationItemOverrides(db, id),
			location.menu_id ? getMenuById(db, location.menu_id) : Promise.resolve(null)
		]);
		const currency = menu[0]?.currency;
		// Provenance is menu-level: the handler surfaces the menu's sources on the location.
		const result = {
			...location,
			sources: menuRow?.sources ?? [],
			...(currency ? { currency } : {}),
			menu: menu.map(itemWithinParent),
			overrides
		};
		expect(() => v.parse(getLocationOutput, result)).not.toThrow();
	}
});

test('get_location output validates for the names and summary views', async () => {
	const db = freshDb();
	const { indieId } = await seedRich(db);
	const location = present(await getLocationById(db, indieId));
	const menu = await getFoodByLocation(db, indieId);
	const overrides = await getLocationItemOverrides(db, indieId);
	const menuRow = location.menu_id ? await getMenuById(db, location.menu_id) : null;
	const currency = menu[0]?.currency;
	const base = { ...location, sources: menuRow?.sources ?? [], ...(currency ? { currency } : {}) };

	// names view: lean per-item shape.
	const names = { ...base, menu: menu.map(itemNameView), overrides };
	expect(() => v.parse(getLocationOutput, names)).not.toThrow();

	// summary view: counts + histogram, no `menu` array.
	const summary = { ...base, ...menuItemsSummary(menu), overrides };
	expect(() => v.parse(getLocationOutput, summary)).not.toThrow();
});

test('list_locations output validates for both the paged and count_only shapes', async () => {
	const db = freshDb();
	await seedRich(db);
	const rows = await getLocationsWithTags(db, { limit: 51 });
	const paged = buildListLocationsPage(rows.map(projectLocationOverview), 50, 0);
	expect(() => v.parse(listLocationsOutput, paged)).not.toThrow();

	const countOnly = { count: await countLocations(db) };
	expect(() => v.parse(listLocationsOutput, countOnly)).not.toThrow();
});

test('audit_locations output validates for the empty_menu and duplicate_locations shapes', async () => {
	const db = freshDb();
	await seedRich(db);
	// Add an empty venue so empty_menu returns a non-trivial work-list.
	await insertLocations(db, [
		{
			name: 'Empty',
			category: 'cafe',
			latitude: 49.3,
			longitude: -123.1,
			street: '3 Empty St',
			city: 'Vancouver',
			region: 'BC',
			postcode: null,
			country: 'CA',
			phone: null,
			website: null
		}
	]);
	const empty = await findIncompleteMenus(db, { min_items: 2 });
	expect(() => v.parse(auditLocationsOutput, empty)).not.toThrow();
	const dupes = await findDuplicateLocations(db);
	expect(() => v.parse(auditLocationsOutput, dupes)).not.toThrow();
	const entities = await findHtmlEntities(db);
	expect(() => v.parse(auditLocationsOutput, entities)).not.toThrow();
});

// --- batch-write result shapes (mirroring the handler return expressions) ----

test('create_locations output validates (full and minimal)', () => {
	const full = {
		created: 1,
		location_ids: ['loc-1'],
		items_created: 2,
		item_ids: ['it-1', 'it-2'],
		skipped_existing_ids: ['loc-0'],
		skipped_duplicate_locations: [{ name: 'Dup', existing_id: 'loc-9' }],
		skipped_invalid: [{ name: 'Bad', osm_id: 'node/1', reason: 'no street' }],
		warnings: ['possible double-mapping']
	};
	const minimal = {
		created: 0,
		location_ids: [],
		items_created: 0,
		item_ids: [],
		skipped_existing_ids: []
	};
	expect(() => v.parse(createLocationsOutput, full)).not.toThrow();
	expect(() => v.parse(createLocationsOutput, minimal)).not.toThrow();
});

test('update_locations / update_items outputs validate', () => {
	const upd = { updated: 2, updated_ids: ['a', 'b'], not_found_ids: ['missing'] };
	expect(() => v.parse(updateLocationsOutput, upd)).not.toThrow();
	expect(() => v.parse(updateItemsOutput, upd)).not.toThrow();
});

test('create_items output validates (with and without name_collisions)', () => {
	const withColl = {
		created: 1,
		item_ids: ['it-1'],
		skipped_existing_ids: [],
		name_collisions: [{ item_name: 'Bucket', existing_ids: ['it-0'] }]
	};
	const without = { created: 2, item_ids: ['it-1', 'it-2'], skipped_existing_ids: ['it-0'] };
	expect(() => v.parse(createItemsOutput, withColl)).not.toThrow();
	expect(() => v.parse(createItemsOutput, without)).not.toThrow();
});

test('create_chain / delete_locations outputs validate (full and minimal)', () => {
	const chainFull = {
		brand_id: 'b-1',
		menu_id: 'm-1',
		item_ids: ['it-1', 'it-2'],
		created_items: 2,
		already_existed: { brand: true, menu: false },
		warnings: ['A brand named "X" already exists']
	};
	const chainMin = { brand_id: 'b-1', menu_id: 'm-1', item_ids: [], created_items: 0 };
	expect(() => v.parse(createChainOutput, chainFull)).not.toThrow();
	expect(() => v.parse(createChainOutput, chainMin)).not.toThrow();

	const del = { deleted: 1, deleted_ids: ['loc-1'], not_found_ids: ['missing'] };
	expect(() => v.parse(deleteLocationsOutput, del)).not.toThrow();
});
