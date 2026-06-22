/// <reference types="bun-types" />
// Exercises getMapData (the read behind the map page's getLocations remote). Its
// whole point is to send each shared brand menu ONCE — keyed by menu_id — rather
// than copied onto every branch, while still exposing each branch's own `food`
// and its per-item overrides so the client can rebuild the effective menu. It
// also scopes the read to a viewport bounding box, so only on-screen locations
// (and the menus they reference) are returned; getLocationMapData is the same
// read for a single location by id. Runs against the real migration schema via
// the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	getMapData,
	getLocationMapData,
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

// A box wide enough to contain every location seeded below (Toronto + Vancouver).
const WORLD = { minLat: 40, maxLat: 50, minLng: -130, maxLng: -70 };

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

	const { locations, menus } = await getMapData(db, WORLD);

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

	// A viewport around the Toronto branches excludes the Vancouver cafe, yet still
	// carries the shared menu those branches reference (so the client can rebuild it).
	const toronto = await getMapData(db, { minLat: 43, maxLat: 44, minLng: -80, maxLng: -79 });
	expect(toronto.locations.map((l) => l.id).toSorted()).toEqual([branchA, branchB].toSorted());
	expect(Object.keys(toronto.menus)).toEqual([menuId]);

	// getLocationMapData returns a single location in the same MapData shape. The
	// independent cafe brings its own food and no shared menu...
	const justCafe = await getLocationMapData(db, cafeId);
	expect(justCafe.locations.map((l) => l.id)).toEqual([cafeId]);
	expect(justCafe.locations[0].food.map((f) => f.item_name)).toEqual(['Latte']);
	expect(justCafe.menus).toEqual({});

	// ...while a chain branch brings its overrides plus the shared menu it serves.
	const justBranchB = await getLocationMapData(db, branchB);
	expect(justBranchB.locations.map((l) => l.id)).toEqual([branchB]);
	expect(Object.keys(justBranchB.menus)).toEqual([menuId]);
	expect(justBranchB.locations[0].overrides).toEqual([
		{ location_id: branchB, menu_item_id: friesId, available: null, price: 5 },
		{ location_id: branchB, menu_item_id: bucketId, available: false, price: null }
	]);

	// An id that matches nothing yields an empty payload.
	const missing = await getLocationMapData(db, 'does-not-exist');
	expect(missing.locations).toEqual([]);
	expect(missing.menus).toEqual({});
});
