import { test, expect } from 'bun:test';
import { findHtmlEntities } from './find-html-entities';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	updateItems,
	updateLocations,
	updateBrand,
	updateMenu
} from '../../src/lib/server/db-write';
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

// --- write-path decoding: entities never reach the db in the first place ----

test('inserts decode HTML entities in item, location, menu and brand names', async () => {
	const db = freshDb();
	const [venue] = await insertLocations(db, [
		loc({
			name: 'Ben &amp; Jerry&#39;s',
			items: [
				{
					item_name: 'Mac &amp; Cheese',
					description: 'A &quot;classic&quot; caf&eacute; dish'
				}
			]
		})
	]);
	const locRow = await db
		.prepare(`SELECT name, menu_id FROM locations WHERE id = ?`)
		.bind(venue)
		.first<{ name: string; menu_id: string }>();
	expect(locRow?.name).toBe("Ben & Jerry's");
	const item = await db
		.prepare(`SELECT item_name, description FROM items WHERE menu_id = ?`)
		.bind(locRow?.menu_id)
		.first<{ item_name: string; description: string }>();
	expect(item?.item_name).toBe('Mac & Cheese');
	expect(item?.description).toBe('A "classic" café dish');
	// The private menu is named after the venue — decoded too.
	const menuRow = await db
		.prepare(`SELECT name FROM menus WHERE id = ?`)
		.bind(locRow?.menu_id)
		.first<{ name: string }>();
	expect(menuRow?.name).toBe("Ben & Jerry's");

	const brandId = await insertBrand(db, {
		name: 'H&amp;W Burgers',
		website: null,
		logo_url: null
	});
	expect(
		(
			await db
				.prepare(`SELECT name FROM brands WHERE id = ?`)
				.bind(brandId)
				.first<{ name: string }>()
		)?.name
	).toBe('H&W Burgers');
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'H&amp;W CA'
	});
	expect(
		(await db.prepare(`SELECT name FROM menus WHERE id = ?`).bind(menuId).first<{ name: string }>())
			?.name
	).toBe('H&W CA');
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Surf &amp; Turf' }]);
	expect(
		(
			await db
				.prepare(`SELECT item_name FROM items WHERE id = ?`)
				.bind(itemId)
				.first<{ item_name: string }>()
		)?.item_name
	).toBe('Surf & Turf');
});

test('updates decode HTML entities too', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'ChainCo',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'ChainCo CA'
	});
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Combo' }]);
	const [venue] = await insertLocations(db, [
		loc({
			name: 'ChainCo',
			category: 'fast_food',
			brand_id: brandId,
			menu_id: menuId
		})
	]);

	await updateItems(db, [
		{
			id: itemId,
			item_name: 'Bacon &amp; Egg',
			description: 'Ham &amp; cheese'
		}
	]);
	const item = await db
		.prepare(`SELECT item_name, description FROM items WHERE id = ?`)
		.bind(itemId)
		.first<{ item_name: string; description: string }>();
	expect(item?.item_name).toBe('Bacon & Egg');
	expect(item?.description).toBe('Ham & cheese');

	await updateLocations(db, [{ id: venue, name: 'Fish &amp; Chips Hut' }]);
	expect(
		(
			await db
				.prepare(`SELECT name FROM locations WHERE id = ?`)
				.bind(venue)
				.first<{ name: string }>()
		)?.name
	).toBe('Fish & Chips Hut');

	await updateBrand(db, brandId, { name: 'B&amp;B Cafe' });
	expect(
		(
			await db
				.prepare(`SELECT name FROM brands WHERE id = ?`)
				.bind(brandId)
				.first<{ name: string }>()
		)?.name
	).toBe('B&B Cafe');
	await updateMenu(db, menuId, { name: 'B&amp;B CA' });
	expect(
		(await db.prepare(`SELECT name FROM menus WHERE id = ?`).bind(menuId).first<{ name: string }>())
			?.name
	).toBe('B&B CA');
});

// --- the audit: flags legacy encoded rows that predate the write-path decoder

test('clean database returns an empty work-list', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Fish & Chips Hut',
			items: [{ item_name: 'Fish & Chips', price: 12 }]
		})
	]);
	const res = await findHtmlEntities(db);
	expect(res.total).toBe(0);
	expect(res.items).toEqual([]);
	expect(res.locations).toEqual([]);
	expect(res.menus).toEqual([]);
	expect(res.brands).toEqual([]);
	expect(res.additional).toBe(0);
});

test('flags encoded item names/descriptions with decoded fix and serving locations', async () => {
	const db = freshDb();
	const [venue] = await insertLocations(db, [
		loc({
			name: 'Legacy Cafe',
			items: [{ item_name: 'Muffin', description: 'Plain' }]
		})
	]);
	// Simulate legacy rows written before the decoder existed.
	await db
		.prepare(`UPDATE items SET item_name = 'Bacon &amp; Egg', description = 'Tom&#39;s pick'`)
		.run();

	const res = await findHtmlEntities(db);
	expect(res.total).toBe(2); // both fields of the one item
	expect(res.items.map((i) => [i.field, i.value, i.decoded])).toEqual([
		['item_name', 'Bacon &amp; Egg', 'Bacon & Egg'],
		['description', 'Tom&#39;s pick', "Tom's pick"]
	]);
	expect(res.items[0].locations).toEqual([{ id: venue, name: 'Legacy Cafe' }]);
	expect(res.items[0].location_count).toBe(1);
});

test('flags encoded location, menu and brand names; ignores plain ampersands', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, {
		name: 'CleanBrand',
		website: null,
		logo_url: null
	});
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'CleanBrand CA'
	});
	const [venue] = await insertLocations(db, [
		loc({ name: 'Clean Venue', brand_id: brandId, menu_id: menuId }),
		loc({ name: 'Soup & Salad; Etc' }) // plain "&" + ";" — must NOT be flagged
	]);
	await db.prepare(`UPDATE locations SET name = 'A&amp;W Legacy' WHERE id = ?`).bind(venue).run();
	await db.prepare(`UPDATE menus SET name = 'A&amp;W CA' WHERE id = ?`).bind(menuId).run();
	await db.prepare(`UPDATE brands SET name = 'A&amp;W' WHERE id = ?`).bind(brandId).run();

	const res = await findHtmlEntities(db);
	expect(res.locations).toEqual([
		{
			id: venue,
			name: 'A&amp;W Legacy',
			decoded: 'A&W Legacy',
			address: '1 Test St, Vancouver, BC V6J 1M5'
		}
	]);
	expect(res.menus).toEqual([{ id: menuId, name: 'A&amp;W CA', decoded: 'A&W CA' }]);
	expect(res.brands).toEqual([{ id: brandId, name: 'A&amp;W', decoded: 'A&W' }]);
	expect(res.total).toBe(3);
	expect(res.items).toEqual([]);
});

test('limit caps each list and counts the cut rows in additional', async () => {
	const db = freshDb();
	const [venue] = await insertLocations(db, [
		loc({
			name: 'Legacy Cafe',
			items: [{ item_name: 'One' }, { item_name: 'Two' }, { item_name: 'Three' }]
		})
	]);
	await db.prepare(`UPDATE items SET item_name = item_name || ' &amp; more'`).run();

	const res = await findHtmlEntities(db, { limit: 2 });
	expect(res.total).toBe(3);
	expect(res.items.length).toBe(2);
	expect(res.returned).toBe(2);
	expect(res.additional).toBe(1);
	void venue;
});
