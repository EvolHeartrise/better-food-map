/// <reference types="bun-types" />
// Exercises getStats — the aggregate coverage totals behind the PUBLIC landing
// overlay (locations, menu items, cities, countries). Two things the counts must get
// right: cities are distinct by the (city, region, country) triple (so same-named
// cities in different provinces/countries stay separate, and extra branches in an
// already-counted city don't inflate it), and chain menu items are counted ONCE —
// they live in the `items` table regardless of how many branches serve that menu.
// Runs against the real migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	getStats,
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	type LocationInsert
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

// A full LocationInsert with sensible defaults, so each test only states what matters
// (name, place, and any inline items).
function venue(
	over: Partial<LocationInsert> & Pick<LocationInsert, 'name' | 'city' | 'region' | 'country'>
): LocationInsert {
	return {
		category: 'cafe',
		latitude: 49.2,
		longitude: -123.1,
		street: '1 Test St',
		postcode: null,
		phone: null,
		website: null,
		...over
	};
}

test('getStats counts locations, items, cities and countries (chain items once)', async () => {
	const db = freshDb();

	// Three independent venues across three distinct cities / two countries, each with
	// its own inline menu items (a private menu per venue).
	await insertLocations(db, [
		venue({
			name: 'Indie Cafe',
			city: 'Vancouver',
			region: 'BC',
			country: 'CA',
			items: [
				{ item_name: 'Latte', price: 4 },
				{ item_name: 'Muffin', price: 3 }
			]
		}),
		venue({
			name: 'Bagel Bar',
			city: 'Toronto',
			region: 'ON',
			country: 'CA',
			items: [{ item_name: 'Bagel', price: 2 }]
		}),
		venue({
			name: 'Pike Coffee',
			city: 'Seattle',
			region: 'WA',
			country: 'US',
			items: [{ item_name: 'Drip', price: 3 }]
		})
	]);

	// A chain: two branches sharing one menu of two items. The branches add two
	// locations but no new city (both in Vancouver/BC/CA) and no extra items.
	const brandId = await insertBrand(db, { name: 'KFC', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'KFC Canada', region: 'CA' });
	await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Bucket', price: 20 },
		{ menu_id: menuId, item_name: 'Fries', price: 4 }
	]);
	await insertLocations(db, [
		venue({
			name: 'KFC Robson',
			category: 'fast_food',
			city: 'Vancouver',
			region: 'BC',
			country: 'CA',
			brand_id: brandId,
			menu_id: menuId
		}),
		venue({
			name: 'KFC Davie',
			category: 'fast_food',
			city: 'Vancouver',
			region: 'BC',
			country: 'CA',
			brand_id: brandId,
			menu_id: menuId
		})
	]);

	const stats = await getStats(db);
	expect(stats).toEqual({
		locations: 5, // 3 independent + 2 chain branches
		items: 6, // 2 + 1 + 1 independent, plus the 2 shared chain items counted once
		cities: 3, // Vancouver/BC/CA, Toronto/ON/CA, Seattle/WA/US
		countries: 2 // CA, US
	});
});

test('getStats returns zeros for an empty database', async () => {
	const db = freshDb();
	expect(await getStats(db)).toEqual({ locations: 0, items: 0, cities: 0, countries: 0 });
});

test('getStats keeps same-named cities in different regions distinct', async () => {
	const db = freshDb();
	await insertLocations(db, [
		venue({ name: 'A', city: 'London', region: 'ON', country: 'CA' }),
		venue({ name: 'B', city: 'London', region: 'ENG', country: 'GB' })
	]);

	const stats = await getStats(db);
	expect(stats.cities).toBe(2);
	expect(stats.countries).toBe(2);
});
