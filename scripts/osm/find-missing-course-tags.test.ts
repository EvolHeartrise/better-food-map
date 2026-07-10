import { test, expect } from 'bun:test';
import { findMissingCourseTags } from './find-missing-course-tags';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationClosed
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

test('flags an item with no course tag; leaves a food-tagged item alone', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [
				{ item_name: 'Untagged Thing', price: 5 },
				{ item_name: 'Burger', price: 10, tags: ['food'] }
			]
		})
	]);

	const res = await findMissingCourseTags(db);
	expect(res.items.map((i) => i.item_name)).toEqual(['Untagged Thing']);
	expect(res.total).toBe(1);
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(0);
});

test('an item whose ONLY course tag is optional still counts as missing (never course-reviewed)', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [{ item_name: 'Maybe Vegan Shake', price: 6, optionalTags: ['drink'] }]
		})
	]);

	const res = await findMissingCourseTags(db);
	expect(res.items.map((i) => i.item_name)).toEqual(['Maybe Vegan Shake']);
});

test('reports menu_id/menu_name and the live location count serving that menu', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'ChainCo CA', currency: 'CAD' });
	const [itemId] = await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Combo', price: 10 }]);
	const [branchA, branchB] = await insertLocations(db, [
		loc({ name: 'ChainCo A', category: 'fast_food', brand_id: brandId, menu_id: menuId }),
		loc({ name: 'ChainCo B', category: 'fast_food', brand_id: brandId, menu_id: menuId })
	]);

	const res = await findMissingCourseTags(db);
	expect(res.items).toHaveLength(1);
	expect(res.items[0].id).toBe(itemId);
	expect(res.items[0].menu_id).toBe(menuId);
	expect(res.items[0].menu_name).toBe('ChainCo CA');
	expect(res.items[0].location_count).toBe(2);

	// Closing one branch drops the live count but the item is still flagged.
	await setLocationClosed(db, branchA, Date.now(), 'closed for test');
	const res2 = await findMissingCourseTags(db);
	expect(res2.items[0].location_count).toBe(1);
	void branchB;
});

test('hint suggests drink/dessert via word-boundary keyword match, never a substring', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [
				{ item_name: 'Iced Latte', price: 5 }, // drink hint
				{ item_name: 'Chocolate Cheesecake', price: 7 }, // dessert hint
				{ item_name: 'Chicken Platter', price: 12 }, // must NOT match "latte" inside "platter"
				{ item_name: 'Cola', price: 3 } // must NOT match "chocolate"-adjacent words
			]
		})
	]);

	const res = await findMissingCourseTags(db);
	const byName = new Map(res.items.map((i) => [i.item_name, i.hint]));
	expect(byName.get('Iced Latte')).toBe('drink');
	expect(byName.get('Chocolate Cheesecake')).toBe('dessert');
	expect(byName.get('Chicken Platter')).toBe(null);
	expect(byName.get('Cola')).toBe('drink');
});

test('orders hint-first (drink, then dessert, then none), then by menu/item name', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [
				{ item_name: 'Mystery Dish', price: 1 }, // no hint
				{ item_name: 'Brownie', price: 4 }, // dessert
				{ item_name: 'Espresso', price: 3 } // drink
			]
		})
	]);

	const res = await findMissingCourseTags(db);
	expect(res.items.map((i) => i.hint)).toEqual(['drink', 'dessert', null]);
	expect(res.items.map((i) => i.item_name)).toEqual(['Espresso', 'Brownie', 'Mystery Dish']);
});

test('excludes items that already carry a required course tag; dessert+drink combo is fine', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [
				{ item_name: 'Milkshake', price: 6, tags: ['dessert', 'drink'] },
				{ item_name: 'Fries', price: 4, tags: ['food'] }
			]
		})
	]);

	expect((await findMissingCourseTags(db)).total).toBe(0);
});

test('limit/offset page the flagged set and report total/additional', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [
				{ item_name: 'Alpha', price: 1 },
				{ item_name: 'Beta', price: 1 },
				{ item_name: 'Gamma', price: 1 }
			]
		})
	]);

	const page1 = await findMissingCourseTags(db, { limit: 2 });
	expect(page1.items.map((i) => i.item_name)).toEqual(['Alpha', 'Beta']);
	expect(page1.total).toBe(3);
	expect(page1.returned).toBe(2);
	expect(page1.additional).toBe(1);
	expect(page1.limit).toBe(2);
	expect(page1.offset).toBe(0);

	const page2 = await findMissingCourseTags(db, { limit: 2, offset: 2 });
	expect(page2.items.map((i) => i.item_name)).toEqual(['Gamma']);
	expect(page2.returned).toBe(1);
	expect(page2.additional).toBe(0);
});

test('dismissals suppress items; a stale offset clamps additional at 0', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Cafe',
			items: [{ item_name: 'Mystery A' }, { item_name: 'Mystery B' }]
		})
	]);

	const first = await findMissingCourseTags(db);
	expect(first.total).toBe(2);
	const [target] = first.items;
	const dismissals = new Map([
		[
			target.id,
			{ fingerprint: '', reason: 'course unsourceable for now', dismissed_at: '2026-07-09' }
		]
	]);
	const suppressed = await findMissingCourseTags(db, { dismissals });
	expect(suppressed.total).toBe(1);
	expect(suppressed.suppressed_dismissed).toBe(1);
	expect(suppressed.items.map((i) => i.id)).not.toContain(target.id);

	// An offset past the (shrunken) end must not report negative remaining work.
	const past = await findMissingCourseTags(db, { offset: 50, dismissals });
	expect(past.returned).toBe(0);
	expect(past.additional).toBe(0);
});
