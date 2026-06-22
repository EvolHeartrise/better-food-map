/// <reference types="bun-types" />
// Exercises getMapData (the read behind the map page's getLocations remote). Its
// whole point is to send each shared brand menu ONCE — keyed by menu_id — rather
// than copied onto every branch, while still exposing each branch's own `food`
// and its per-item overrides so the client can rebuild the effective menu.
// Runs against the real migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	getMapData,
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('getMapData sends a shared menu once, with per-branch food and overrides', async () => {
	const db = freshDb();

	const brandId = await insertBrand(db, { name: 'KFC', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'KFC Canada',
		region: 'CA',
		last_verified: null
	});
	const [bucketId, friesId] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Bucket', ingredients: null, price: 20, tags: ['halal'] },
		{ menu_id: menuId, item_name: 'Fries', ingredients: 'potato', price: 4 }
	]);

	// Two branches share the menu; one independent cafe carries its own `food`.
	const [branchA, branchB] = await insertLocations(db, [
		{
			name: 'KFC Yonge',
			category: 'fast_food',
			latitude: 43.6,
			longitude: -79.4,
			address: null,
			phone: null,
			website: null,
			brand_id: brandId,
			menu_id: menuId
		},
		{
			name: 'KFC King',
			category: 'fast_food',
			latitude: 43.7,
			longitude: -79.3,
			address: null,
			phone: null,
			website: null,
			brand_id: brandId,
			menu_id: menuId
		}
	]);
	const [cafeId] = await insertLocations(db, [
		{
			name: 'Indie Cafe',
			category: 'cafe',
			latitude: 49.2,
			longitude: -123.1,
			address: null,
			phone: null,
			website: null
		}
	]);
	await insertFoods(db, [{ location_id: cafeId, item_name: 'Latte', ingredients: null, price: 5 }]);

	// Branch B deviates: pricier Fries, and Bucket not served.
	await setLocationItemOverride(db, branchB, friesId, { price: 5 });
	await setLocationItemOverride(db, branchB, bucketId, { available: false });

	const { locations, menus } = await getMapData(db);

	// The shared menu appears exactly once, item-name ordered, with its tags/sources.
	expect(Object.keys(menus)).toEqual([menuId]);
	expect(menus[menuId].map((i) => i.item_name)).toEqual(['Bucket', 'Fries']);
	expect(menus[menuId].find((i) => i.id === bucketId)?.tags.map((t) => t.id)).toEqual(['halal']);

	// ...and is NOT copied onto either branch: each chain branch carries no own food.
	const a = locations.find((l) => l.id === branchA);
	const b = locations.find((l) => l.id === branchB);
	expect(a?.menu_id).toBe(menuId);
	expect(a?.food).toEqual([]);
	expect(a?.overrides).toEqual([]);

	// Branch B carries only its deltas (available as a boolean|null, not 0/1).
	expect(b?.overrides).toEqual([
		{ location_id: branchB, menu_item_id: friesId, available: null, price: 5 },
		{ location_id: branchB, menu_item_id: bucketId, available: false, price: null }
	]);

	// The independent venue keeps its own food and serves no shared menu.
	const cafe = locations.find((l) => l.id === cafeId);
	expect(cafe?.menu_id).toBeNull();
	expect(cafe?.food.map((f) => f.item_name)).toEqual(['Latte']);
	expect(cafe?.overrides).toEqual([]);
});
