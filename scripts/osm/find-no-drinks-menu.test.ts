import { test, expect } from 'bun:test';
import { findNoDrinksMenus } from './find-no-drinks-menu';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride,
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

const food = (name: string) => ({ item_name: name, tags: ['food' as const] });
const drink = (name: string) => ({ item_name: name, tags: ['drink' as const] });

test('flags a restaurant with items but no drinks; leaves one with a drink alone', async () => {
	const db = freshDb();
	const [drinkless] = await insertLocations(db, [
		loc({ name: 'Drinkless Diner', items: [food('Burger'), food('Fries')] }),
		loc({ name: 'Stocked Diner', items: [food('Burger'), drink('Cola')] })
	]);

	const res = await findNoDrinksMenus(db);
	expect(res.locations.map((l) => l.id)).toEqual([drinkless]);
	expect(res.locations[0].item_count).toBe(2);
	expect(res.locations[0].address).toBe('1 Test St, Vancouver, BC V6J 1M5');
	expect(res.total).toBe(1);
	expect(res.returned).toBe(1);
	expect(res.additional).toBe(0);
});

test('only restaurants are in scope; empty menus are left to empty_menu', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({ name: 'Drinkless Cafe', category: 'cafe', items: [food('Toast')] }),
		loc({
			name: 'Drinkless Fast Food',
			category: 'fast_food',
			items: [food('Combo')]
		}),
		loc({ name: 'Empty Restaurant' }) // 0 items → empty_menu's problem, not ours
	]);
	expect((await findNoDrinksMenus(db)).total).toBe(0);
});

test('a dessert+drink combo item counts as a drink', async () => {
	const db = freshDb();
	await insertLocations(db, [
		loc({
			name: 'Shake Shop',
			items: [
				food('Burger'),
				{
					item_name: 'Milkshake',
					tags: ['dessert' as const, 'drink' as const]
				}
			]
		})
	]);
	expect((await findNoDrinksMenus(db)).total).toBe(0);
});

test('a chain branch is judged on its shared menu, minus unavailable overrides', async () => {
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
	const [, cola] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Combo', tags: ['food'] },
		{ menu_id: menuId, item_name: 'Cola', tags: ['drink'] }
	]);
	const [branch] = await insertLocations(db, [
		loc({ name: 'ChainCo Grill', brand_id: brandId, menu_id: menuId })
	]);

	// The shared menu has a drink → not flagged.
	expect((await findNoDrinksMenus(db)).total).toBe(0);

	// This branch overrides its only drink to unavailable → flagged, with the
	// effective (drink-less) item count.
	await setLocationItemOverride(db, branch, cola, { available: false });
	const res = await findNoDrinksMenus(db);
	expect(res.locations.map((l) => l.id)).toEqual([branch]);
	expect(res.locations[0].item_count).toBe(1);
	expect(res.locations[0].brand_id).toBe(brandId);
});

test('min_items raises the floor; excludes closed venues; biggest menus lead', async () => {
	const db = freshDb();
	const [, big] = await insertLocations(db, [
		loc({ name: 'Tiny', items: [food('One')] }),
		loc({ name: 'Big', items: [food('A'), food('B'), food('C')] }),
		loc({ name: 'Mid', items: [food('A'), food('B')] })
	]);
	const [closed] = await insertLocations(db, [
		loc({ name: 'Closed Drinkless', items: [food('X')] })
	]);
	await setLocationClosed(db, closed, Date.now(), 'closed for test');

	// Biggest drink-less menu first — the strongest missed-page signal.
	const all = await findNoDrinksMenus(db);
	expect(all.locations.map((l) => l.name)).toEqual(['Big', 'Mid', 'Tiny']);
	expect(all.total).toBe(3);

	// min_items: 3 keeps only the big menu; limit/additional page the rest.
	const floored = await findNoDrinksMenus(db, { min_items: 3 });
	expect(floored.locations.map((l) => l.id)).toEqual([big]);
	expect(floored.min_items).toBe(3);

	const capped = await findNoDrinksMenus(db, { limit: 2 });
	expect(capped.returned).toBe(2);
	expect(capped.additional).toBe(1);
});

test('a dismissal pins the verified item count — a changed menu size re-flags', async () => {
	const { splitDismissKey } = await import('./audit-dismiss');
	const db = freshDb();
	const [venue] = await insertLocations(db, [
		loc({ name: 'Genuinely No Drinks', items: [food('Set Menu')] })
	]);

	const first = await findNoDrinksMenus(db);
	expect(first.locations[0].dismiss_key).toBe(`${venue}#1`);

	const { subject, fingerprint } = splitDismissKey(first.locations[0].dismiss_key)!;
	const dismissals = new Map([
		[
			subject,
			{
				fingerprint,
				reason: 'source lists no drinks',
				dismissed_at: '2026-07-11'
			}
		]
	]);
	const suppressed = await findNoDrinksMenus(db, { dismissals });
	expect(suppressed.locations.length).toBe(0);
	expect(suppressed.suppressed_dismissed).toBe(1);

	// Under include_dismissed the venue surfaces annotated instead.
	const surfaced = await findNoDrinksMenus(db, {
		dismissals,
		include_dismissed: true
	});
	expect(surfaced.locations[0].dismissed?.reason).toBe('source lists no drinks');

	// A menu that grew since the verdict is new evidence — the stale dismissal
	// no longer suppresses.
	const { insertFoods } = await import('../../src/lib/server/db-write');
	await insertFoods(db, [{ location_id: venue, item_name: 'New Dish', tags: ['food'] }]);
	const reflagged = await findNoDrinksMenus(db, { dismissals });
	expect(reflagged.locations.map((l) => l.id)).toEqual([venue]);
	expect(reflagged.locations[0].dismiss_key).toBe(`${venue}#2`);
});
