/// <reference types="bun-types" />
// Exercises getMapData (the read behind the map page's getLocations remote). Its
// whole point is to send each menu ONCE — keyed by menu_id — rather than copied
// onto every location that serves it, while still exposing each location's
// per-item overrides so the client can rebuild the effective menu. It also scopes
// the read to a viewport bounding box, so only on-screen locations (and the menus
// they reference) are returned; getLocationMapData is the same read for a single
// location by id. Runs against the real migration schema via the in-memory
// D1Like adapter.
//
// Unified model (migration 0004): a chain branch serves a shared brand menu; an
// independent venue gets its own PRIVATE menu (id `pm-<location_id>`), so its
// items live in the `menus` payload too — keyed by that private menu id.

import { test, expect } from 'bun:test';
import {
	getMapData,
	getLocationMapData,
	getSearchMapData,
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

test('getMapData sends each menu once, with per-branch overrides and a private menu per venue', async () => {
	const db = freshDb();

	const brandId = await insertBrand(db, { name: 'KFC', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'KFC Canada',
		region: 'CA'
	});
	const [bucketId, friesId] = await insertMenuItems(db, [
		{ menu_id: menuId, item_name: 'Bucket', price: 20, tags: ['halal'] },
		{ menu_id: menuId, item_name: 'Fries', price: 4 }
	]);

	// Two branches share the menu; one independent cafe carries its own items.
	const [branchA, branchB] = await insertLocations(db, [
		{
			name: 'KFC Yonge',
			category: 'fast_food',
			latitude: 43.6,
			longitude: -79.4,
			street: '1 Test St',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
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
			street: '1 Test St',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
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
			street: '1 Test St',
			city: 'Vancouver',
			region: 'BC',
			postcode: 'V6J 1M5',
			country: 'CA',
			phone: null,
			website: null
		}
	]);
	// The independent venue's own items go on a private menu created for it.
	await insertFoods(db, [
		{
			location_id: cafeId,
			item_name: 'Veggie Bowl',
			tags: ['vegan'],
			optionalTags: ['vegetarian'],
			price: 12
		},
		{ location_id: cafeId, item_name: 'Latte', price: 5 }
	]);
	const cafeMenuId = `pm-${cafeId}`;

	// Branch B deviates: pricier Fries, and Bucket not served.
	await setLocationItemOverride(db, branchB, friesId, { price: 5 });
	await setLocationItemOverride(db, branchB, bucketId, { available: false });

	const { locations, menus } = await getMapData(db, WORLD);

	// Each menu appears exactly once: the shared chain menu and the cafe's private one.
	expect(Object.keys(menus).toSorted()).toEqual([menuId, cafeMenuId].toSorted());
	expect(menus[menuId].map((i) => i.item_name)).toEqual(['Bucket', 'Fries']);
	expect(menus[menuId].find((i) => i.id === bucketId)?.tags.map((t) => t.id)).toEqual(['halal']);

	// The shared menu is NOT copied onto either branch: each branch just references it.
	const a = locations.find((l) => l.id === branchA);
	const b = locations.find((l) => l.id === branchB);
	expect(a?.menu_id).toBe(menuId);
	expect(a?.overrides).toEqual([]);

	// Branch B carries only its deltas (available as a boolean|null, not 0/1).
	expect(b?.overrides).toEqual([
		{ location_id: branchB, item_id: friesId, available: null, price: 5 },
		{ location_id: branchB, item_id: bucketId, available: false, price: null }
	]);

	// The independent venue points at its private menu, whose items ship in `menus`.
	const cafe = locations.find((l) => l.id === cafeId);
	expect(cafe?.menu_id).toBe(cafeMenuId);
	expect(cafe?.overrides).toEqual([]);
	expect(menus[cafeMenuId].map((i) => i.item_name)).toEqual(['Latte', 'Veggie Bowl']);

	// Dietary tags are recorded with their per-item `optional` flag (vegan asserted,
	// vegetarian optional — "can be made vegetarian").
	const bowl = menus[cafeMenuId].find((i) => i.item_name === 'Veggie Bowl');
	expect(bowl).toBeDefined();
	expect(bowl?.tags.map((t) => `${t.id}:${t.optional}`).toSorted()).toEqual([
		'vegan:false',
		'vegetarian:true'
	]);

	// A viewport around the Toronto branches excludes the Vancouver cafe, yet still
	// carries the shared menu those branches reference (so the client can rebuild it).
	const toronto = await getMapData(db, { minLat: 43, maxLat: 44, minLng: -80, maxLng: -79 });
	expect(toronto.locations.map((l) => l.id).toSorted()).toEqual([branchA, branchB].toSorted());
	expect(Object.keys(toronto.menus)).toEqual([menuId]);

	// getLocationMapData returns a single location in the same MapData shape: the
	// independent cafe brings its private menu and no chain menu...
	const justCafe = await getLocationMapData(db, cafeId);
	expect(justCafe.locations.map((l) => l.id)).toEqual([cafeId]);
	expect(Object.keys(justCafe.menus)).toEqual([cafeMenuId]);
	expect(justCafe.menus[cafeMenuId].map((i) => i.item_name)).toEqual(['Latte', 'Veggie Bowl']);

	// ...while a chain branch brings its overrides plus the shared menu it serves.
	const justBranchB = await getLocationMapData(db, branchB);
	expect(justBranchB.locations.map((l) => l.id)).toEqual([branchB]);
	expect(Object.keys(justBranchB.menus)).toEqual([menuId]);
	expect(justBranchB.locations[0].overrides).toEqual([
		{ location_id: branchB, item_id: friesId, available: null, price: 5 },
		{ location_id: branchB, item_id: bucketId, available: false, price: null }
	]);

	// An id that matches nothing yields an empty payload.
	const missing = await getLocationMapData(db, 'does-not-exist');
	expect(missing.locations).toEqual([]);
	expect(missing.menus).toEqual({});
});

// The global search behind the `searchLocations` remote. Exercises the new
// single-diet filter (dietTagId) and its place/item companions: a venue matches
// only when ONE of its items satisfies every active predicate, and a diet match
// counts an `optional` tag ("can be made vegan") the same way the client's
// per-item `itemMatches` does — so the two stay in lock-step.
test('getSearchMapData filters by a single dietary tag, counting optional tags', async () => {
	const db = freshDb();
	const addr = {
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null
	};
	const [veganLoc, plainLoc, optLoc] = await insertLocations(db, [
		{ name: 'Green Spot', category: 'restaurant', latitude: 49.28, longitude: -123.12, ...addr },
		{ name: 'Plain Diner', category: 'restaurant', latitude: 49.29, longitude: -123.13, ...addr },
		{ name: 'Flex Kitchen', category: 'restaurant', latitude: 49.3, longitude: -123.14, ...addr }
	]);
	// Green Spot has a vegan item AND a plain one — only the vegan item should make it match.
	await insertFoods(db, [
		{ location_id: veganLoc, item_name: 'Tofu Bowl', tags: ['vegan'], price: 10 },
		{ location_id: veganLoc, item_name: 'Beef Stew', price: 12 }
	]);
	// Plain Diner has nothing vegan.
	await insertFoods(db, [{ location_id: plainLoc, item_name: 'Burger', price: 9 }]);
	// Flex Kitchen has an item that can be MADE vegan (optional vegan tag).
	await insertFoods(db, [
		{ location_id: optLoc, item_name: 'Build-a-Wrap', optionalTags: ['vegan'], price: 8 }
	]);

	const anchor = { lat: 49.28, lng: -123.12 };

	// vegan: the asserted-vegan venue and the can-be-made-vegan venue, not the plain one.
	const vegan = await getSearchMapData(db, { place: '', item: '', dietTagId: 'vegan', ...anchor });
	expect(vegan.locations.map((l) => l.id).toSorted()).toEqual([veganLoc, optLoc].toSorted());

	// A diet no item carries returns nothing.
	const halal = await getSearchMapData(db, { place: '', item: '', dietTagId: 'halal', ...anchor });
	expect(halal.locations).toEqual([]);

	// No diet filter + a place term narrows by venue name alone.
	const byPlace = await getSearchMapData(db, {
		place: 'Plain',
		item: '',
		dietTagId: null,
		...anchor
	});
	expect(byPlace.locations.map((l) => l.id)).toEqual([plainLoc]);

	// Diet + item name must be satisfied by the SAME item: 'Beef Stew' isn't vegan, so
	// Green Spot drops out even though it has a (separate) vegan item.
	const conflicting = await getSearchMapData(db, {
		place: '',
		item: 'Beef',
		dietTagId: 'vegan',
		...anchor
	});
	expect(conflicting.locations).toEqual([]);
});
