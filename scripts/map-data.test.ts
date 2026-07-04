/// <reference types="bun-types" />
// Exercises the viewport read behind the map page's getMapCells remote (via the
// harness's viewportMapData, which composes grid level + cells + getMapCellsData
// exactly the way the page does). Its whole point is to send each menu ONCE —
// keyed by menu_id — rather than copied onto every location that serves it,
// while still exposing each location's per-item overrides so the client can
// rebuild the effective menu. It also scopes the read to the cells covering the
// viewport, so only on-screen locations (and the menus they reference) are
// returned; getLocationMapData is the same read for a single location by id.
// Runs against the real migration schema via the in-memory D1Like adapter.
//
// Unified model (migration 0004): a chain branch serves a shared brand menu; an
// independent venue gets its own PRIVATE menu (id `pm-<location_id>`), so its
// items live in the `menus` payload too — keyed by that private menu id.

import { test, expect } from 'bun:test';
import {
	getLocationMapData,
	insertLocations,
	insertFoods,
	insertBrand,
	insertMenu,
	insertMenuItems,
	setLocationItemOverride,
	MAP_RESULT_LIMIT
} from '../src/lib/server/db';
import { freshDb, searchMapData, viewportMapData } from './test-d1';

// A box wide enough to contain every location seeded below (Toronto + Vancouver).
const WORLD = { minLat: 40, maxLat: 50, minLng: -130, maxLng: -70 };

test('the viewport read sends each menu once, with per-branch overrides and a private menu per venue', async () => {
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

	// A viewport tight around the Toronto branches: both survive (they fall in distinct
	// grid cells at this zoom) and carry/reference the shared chain menu, while the
	// Vancouver cafe is outside the box. (A wide, zoomed-out box would instead DOWNSAMPLE
	// to one representative per cell — that path is covered by its own test below.)
	const { locations, menus } = await viewportMapData(db, {
		minLat: 43,
		maxLat: 44,
		minLng: -80,
		maxLng: -79
	});
	expect(locations.map((l) => l.id).toSorted()).toEqual([branchA, branchB].toSorted());

	// The shared chain menu appears exactly once, keyed by menu_id — not copied per branch.
	expect(Object.keys(menus)).toEqual([menuId]);
	expect(menus[menuId].map((i) => i.item_name)).toEqual(['Bucket', 'Fries']);
	expect(menus[menuId].find((i) => i.id === bucketId)?.tags.map((t) => t.id)).toEqual(['halal']);

	// Each branch just references the menu: branch A with no deltas...
	const a = locations.find((l) => l.id === branchA);
	const b = locations.find((l) => l.id === branchB);
	expect(a?.menu_id).toBe(menuId);
	expect(a?.overrides).toEqual([]);

	// ...branch B carrying only its deltas (available as a boolean|null, not 0/1).
	expect(b?.menu_id).toBe(menuId);
	expect(b?.overrides).toEqual([
		{ location_id: branchB, item_id: friesId, available: null, price: 5 },
		{ location_id: branchB, item_id: bucketId, available: false, price: null }
	]);

	// getLocationMapData returns a single location in the same MapData shape: the
	// independent cafe brings its PRIVATE menu (no chain menu), its items shipped in
	// `menus` under that private id, and no overrides of its own.
	const justCafe = await getLocationMapData(db, cafeId);
	expect(justCafe.locations.map((l) => l.id)).toEqual([cafeId]);
	expect(justCafe.locations[0].menu_id).toBe(cafeMenuId);
	expect(justCafe.locations[0].overrides).toEqual([]);
	expect(Object.keys(justCafe.menus)).toEqual([cafeMenuId]);
	expect(justCafe.menus[cafeMenuId].map((i) => i.item_name)).toEqual(['Latte', 'Veggie Bowl']);

	// Dietary tags are recorded with their per-item `optional` flag (vegan asserted,
	// vegetarian optional — "can be made vegetarian").
	const bowl = justCafe.menus[cafeMenuId].find((i) => i.item_name === 'Veggie Bowl');
	expect(bowl).toBeDefined();
	expect(bowl?.tags.map((t) => `${t.id}:${t.optional}`).toSorted()).toEqual([
		'vegan:false',
		'vegetarian:true'
	]);

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

// The viewport payload is LEAN (#83): the map UI renders only item names (plus
// tags for the client diet re-filter), so the bulk reads (the viewport read,
// filtered or not) must not ship description/price —
// only the by-id detail read (getLocationMapData, behind the open venue's panel)
// carries the full item shape. Provenance is menu-level, delivered on menuMeta,
// only in detail mode.
test('viewport items are lean; the by-id detail read keeps the full shape', async () => {
	const db = freshDb();

	const brandId = await insertBrand(db, { name: 'Pita Pit', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'Pita Pit Canada',
		region: 'CA',
		sources: [{ url: 'https://pitapit.ca/menu', label: 'Menu' }]
	});
	await insertMenuItems(db, [
		{
			menu_id: menuId,
			item_name: 'Falafel Pita',
			description: 'Chickpea falafel with veg',
			price: 9,
			tags: ['vegan']
		}
	]);
	const [branch] = await insertLocations(db, [
		{
			name: 'Pita Pit Downtown',
			category: 'fast_food',
			latitude: 43.6,
			longitude: -79.4,
			street: '1 Test St',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M5V 2T6',
			country: 'CA',
			phone: null,
			website: null,
			brand_id: brandId,
			menu_id: menuId
		}
	]);

	// The viewport read: lean items — name + tags only, none of the detail fields.
	const viewport = await viewportMapData(db, { minLat: 43, maxLat: 44, minLng: -80, maxLng: -79 });
	expect(viewport.locations.map((l) => l.id)).toEqual([branch]);
	const leanItem = viewport.menus[menuId][0];
	expect(leanItem.item_name).toBe('Falafel Pita');
	expect(leanItem.tags.map((t) => t.id)).toEqual(['vegan']);
	expect('description' in leanItem).toBe(false);
	expect('price' in leanItem).toBe(false);
	expect('sources' in leanItem).toBe(false);
	// Menu freshness metadata still travels with the lean payload; sources do NOT
	// (they are surfaced only in the detail read behind the open venue's panel).
	expect(viewport.menuMeta[menuId].last_verified).not.toBeNull();
	expect(viewport.menuMeta[menuId].sources).toEqual([]);

	// The filtered (search) read shares the lean shape.
	const search = await searchMapData(
		db,
		{ minLat: 43, maxLat: 44, minLng: -80, maxLng: -79 },
		{ query: 'falafel', dietTagId: null }
	);
	expect('price' in search.menus[menuId][0]).toBe(false);

	// The by-id detail read: the full item (description/price/currency), and the
	// menu's sources on menuMeta (provenance is menu-level, not on the item).
	const detail = await getLocationMapData(db, branch);
	const fullItem = detail.menus[menuId][0];
	expect(fullItem.description).toBe('Chickpea falafel with veg');
	expect(fullItem.price).toBe(9);
	expect(fullItem.currency).toBe('CAD');
	expect('sources' in fullItem).toBe(false);
	expect(detail.menuMeta[menuId].sources.map((s) => s.url)).toEqual(['https://pitapit.ca/menu']);
});

// A wide (zoomed-out) viewport is spatially downsampled: the box is tiled into a grid
// and only ONE representative per cell is returned, so the map ships a uniform spread
// rather than thousands of rows it can't legibly draw. The representative is the most
// "important" venue in the cell — one we have a menu for outranks one we don't.
test('the viewport read downsamples a wide viewport to one representative per grid cell', async () => {
	const db = freshDb();
	const addr = {
		street: '1 Test St',
		city: 'Toronto',
		region: 'ON',
		postcode: 'M5V 2T6',
		country: 'CA',
		phone: null,
		website: null
	};
	// Three venues within a few hundred metres (the same cell at a world-wide zoom):
	// two with no menu and one WITH — the menu'd one should win the cell.
	const [, , withMenu] = await insertLocations(db, [
		{ name: 'Aaa Diner', category: 'restaurant', latitude: 43.6, longitude: -79.4, ...addr },
		{ name: 'Bbb Diner', category: 'restaurant', latitude: 43.61, longitude: -79.41, ...addr },
		{ name: 'Ccc Diner', category: 'restaurant', latitude: 43.62, longitude: -79.42, ...addr }
	]);
	await insertFoods(db, [{ location_id: withMenu, item_name: 'Soup', price: 5 }]);
	// A fourth venue far away, in a different cell — kept on its own.
	const [far] = await insertLocations(db, [
		{ name: 'Ddd Cafe', category: 'cafe', latitude: 49.2, longitude: -123.1, ...addr }
	]);

	const wide = await viewportMapData(db, WORLD);
	// The clustered three collapse to the one with a menu; the far one survives alone.
	expect(wide.locations.map((l) => l.id).toSorted()).toEqual([withMenu, far].toSorted());
});

// The wide path returns ALL occupied cells, not a top-N slice of them. The ids used to be
// resolved through an `id IN (?, …)` list and so capped at 96 to stay under D1's per-query
// parameter limit; panning then reshuffled which 96 cells won that cut, flickering labels
// in and out. Passing the ids through a single json_each bind lifts the cap (now just
// MAP_RESULT_LIMIT), so every occupied cell in view comes back regardless of the framing.
test('a wide viewport returns every occupied cell, past the old 96-id cap', async () => {
	const db = freshDb();
	const addr = {
		street: '1 Test St',
		city: 'Toronto',
		region: 'ON',
		postcode: 'M5V 2T6',
		country: 'CA',
		phone: null,
		website: null
	};
	// 120 venues, each alone in its own 5° grid cell within a square box (cell = niceStep(60/12)
	// = 5°), so none collapse together and all 120 are distinct representatives — more than the
	// old 96 cap would have allowed through.
	const box = { minLat: 0, maxLat: 60, minLng: 0, maxLng: 60 };
	const venues = Array.from({ length: 120 }, (_, i) => ({
		name: `Venue ${i}`,
		category: 'restaurant' as const,
		latitude: 2.5 + 5 * Math.floor(i / 12),
		longitude: 2.5 + 5 * (i % 12),
		...addr
	}));
	await insertLocations(db, venues);

	const wide = await viewportMapData(db, box);
	expect(wide.locations.length).toBe(120); // all occupied cells, not a 96-cell slice
	expect(new Set(wide.locations.map((l) => l.id)).size).toBe(120);
});

// When a dense view would hold MORE occupied cells than the cap, gridCellSize coarsens the
// lattice (up the 1-2-5 ladder) so the count stays under the cap and the trailing LIMIT
// never trims. That is what makes the wide path pan-stable: a top-N cut over the in-view
// cells reshuffles as the box slides (the flicker), so we size the grid so there's no cut.
test('a dense wide viewport coarsens under the cap, and its reps are pan-stable', async () => {
	const db = freshDb();
	const addr = {
		street: '1 Test St',
		city: 'Toronto',
		region: 'ON',
		postcode: 'M5V 2T6',
		country: 'CA',
		phone: null,
		website: null
	};
	// A dense field: a venue on every integer degree across a 30°×30° box (961 venues). The
	// base cell is niceStep(30/12) = 2° → ~256 geometric cells > the 200 cap, so without
	// coarsening the LIMIT would trim to exactly 200 (and flicker on pan). gridCellSize
	// coarsens to 5° (~49 cells), well under the cap.
	const venues = Array.from({ length: 31 * 31 }, (_, k) => ({
		name: `V ${Math.floor(k / 31)}-${k % 31}`,
		category: 'restaurant' as const,
		latitude: Math.floor(k / 31),
		longitude: k % 31,
		...addr
	}));
	await insertLocations(db, venues);

	const box = { minLat: 0, maxLat: 30, minLng: 0, maxLng: 30 };
	const a = await viewportMapData(db, box);
	// Strictly under the cap proves coarsening engaged — without it this would be exactly 200.
	expect(a.locations.length).toBeLessThan(MAP_RESULT_LIMIT);
	expect(a.locations.length).toBeGreaterThan(0);

	// Pan by +1° on both axes (same 30° span → same coarsened 5° cell). Representatives whose
	// cell sits fully inside BOTH boxes must be identical — the "no flicker while panning"
	// property. Restrict to the deep interior (≥1 cell inside both) so edge cells, which
	// legitimately enter/leave, don't count.
	const b = await viewportMapData(db, { minLat: 1, maxLat: 31, minLng: 1, maxLng: 31 });
	const interiorIds = (data: Awaited<ReturnType<typeof viewportMapData>>) =>
		data.locations
			.filter((l) => l.latitude >= 6 && l.latitude <= 29 && l.longitude >= 6 && l.longitude <= 29)
			.map((l) => l.id)
			.toSorted();
	expect(interiorIds(a)).toEqual(interiorIds(b));
	expect(interiorIds(a).length).toBeGreaterThan(0); // the stable region isn't trivially empty
});

// The search filter riding the cell read (searchMembership behind getMapCells).
// Exercises the single-diet filter (dietTagId) and its combined-text companion:
// with a diet set a venue matches only when ONE of its items satisfies every
// active predicate, and a diet match counts an `optional` tag ("can be made
// vegan") the same way the client's per-item filter does — so the two stay in
// lock-step.
test('the filtered cell read narrows by a single dietary tag, counting optional tags', async () => {
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

	const box = { minLat: 49.2, maxLat: 49.4, minLng: -123.3, maxLng: -123.0 };

	// vegan: the asserted-vegan venue and the can-be-made-vegan venue, not the plain one.
	const vegan = await searchMapData(db, box, { query: '', dietTagId: 'vegan' });
	expect(vegan.locations.map((l) => l.id).toSorted()).toEqual([veganLoc, optLoc].toSorted());

	// A diet no item carries returns nothing.
	const halal = await searchMapData(db, box, { query: '', dietTagId: 'halal' });
	expect(halal.locations).toEqual([]);

	// A bare text term narrows by venue name alone (no item here is named "Plain").
	const byName = await searchMapData(db, box, { query: 'Plain', dietTagId: null });
	expect(byName.locations.map((l) => l.id)).toEqual([plainLoc]);

	// Text + diet must be satisfied by the SAME item: 'Beef Stew' isn't vegan and no
	// venue is named "Beef", so Green Spot drops out even though it has a (separate)
	// vegan item.
	const conflicting = await searchMapData(db, box, { query: 'Beef', dietTagId: 'vegan' });
	expect(conflicting.locations).toEqual([]);
});

// The combined search: one free-text term that matches a venue by NAME or by an
// item name (an OR), with the dietary selector still narrowing on top. Mirrors the
// client's `matchedItems`/`results` membership so the in-flight client re-filter and
// the server agree.
test('the filtered cell read matches by venue name OR item name, diet still narrowing', async () => {
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
	const [nameOnly, itemOnly, neither, emptyName] = await insertLocations(db, [
		{ name: 'Burrito Barn', category: 'restaurant', latitude: 49.28, longitude: -123.12, ...addr },
		{ name: 'Joe Diner', category: 'restaurant', latitude: 49.29, longitude: -123.13, ...addr },
		{ name: 'Pizza Place', category: 'restaurant', latitude: 49.3, longitude: -123.14, ...addr },
		{
			name: 'Empty Burrito Co',
			category: 'restaurant',
			latitude: 49.31,
			longitude: -123.15,
			...addr
		}
	]);
	// Name contains "burrito" but NO item does — and nothing vegan.
	await insertFoods(db, [{ location_id: nameOnly, item_name: 'Steak Plate', price: 14 }]);
	// Name doesn't match; a vegan item does contain "burrito".
	await insertFoods(db, [
		{ location_id: itemOnly, item_name: 'Veggie Burrito', tags: ['vegan'], price: 11 }
	]);
	// Matches nothing.
	await insertFoods(db, [{ location_id: neither, item_name: 'Margherita', price: 13 }]);
	// emptyName has a matching NAME but no menu at all.

	const box = { minLat: 49.2, maxLat: 49.4, minLng: -123.3, maxLng: -123.0 };

	// Text only: kept when the NAME matches (even with no matching item, and even with
	// an empty menu) OR an item name matches.
	const text = await searchMapData(db, box, { query: 'burrito', dietTagId: null });
	expect(text.locations.map((l) => l.id).toSorted()).toEqual(
		[nameOnly, itemOnly, emptyName].toSorted()
	);

	// Text + diet: diet always narrows, so a NAME-only match with no diet item drops —
	// only the venue whose matching item is itself vegan survives.
	const textDiet = await searchMapData(db, box, { query: 'burrito', dietTagId: 'vegan' });
	expect(textDiet.locations.map((l) => l.id)).toEqual([itemOnly]);
});
