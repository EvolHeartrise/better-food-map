/// <reference types="bun-types" />
// Exercises getMapCellsData (the per-cell read behind the map page's
// getMapCells remote) and the slice helpers the caches are built from. The
// contract under test: a cell's contents are a pure function of the data —
// independent of which other cells share the request — every requested cell
// comes back (empty ones as [], the negative-cache entries), representatives
// are importance-ranked (menu > likes > name), the full level caps per cell,
// and split → assemble round-trips the wire payload. Runs against the real
// migration schema via the in-memory D1Like adapter.

import { test, expect } from 'bun:test';
import {
	FULL_CELL_CAP,
	getMapCellsData,
	insertBrand,
	insertFoods,
	insertLocations,
	insertMenu,
	setLocationLike,
	type LocationInsert,
	type MapCellsData
} from '../src/lib/server/db';
import { assembleCellsData, mergeCellSlices, splitCellSlices } from '../src/lib/map-cells';
import { cellKey, cellsForBounds, levelCell, levelForBounds, MIN_REP_LEVEL } from '../src/lib/grid';
import { CellStore, CELL_STORE_MAX, CELL_TTL_MS } from '../src/lib/cell-store';
import { freshDb } from './test-d1';

/** A complete-address venue with sensible defaults; override per test. */
function venue(over: Partial<LocationInsert> & { name: string }): LocationInsert {
	return {
		category: 'restaurant',
		latitude: 49.2,
		longitude: -123.1,
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

/** The level+cells a viewport resolves to, then fetched — the page's browse read. */
async function fetchViewport(
	db: ReturnType<typeof freshDb>,
	bounds: Parameters<typeof levelForBounds>[0]
) {
	const level = levelForBounds(bounds);
	const cells = cellsForBounds(bounds, levelCell(level));
	return { level, cells, data: await getMapCellsData(db, level, cells) };
}

test('a representative level keeps one importance-ranked venue per cell, empties included', async () => {
	const db = freshDb();
	// Three venues within a few hundred metres (one shared cell at a wide zoom):
	// two menu-less and one WITH a menu — the menu'd one must win the cell.
	const [, , withMenu] = await insertLocations(db, [
		venue({ name: 'Aaa Diner', latitude: 43.6, longitude: -79.4 }),
		venue({ name: 'Bbb Diner', latitude: 43.61, longitude: -79.41 }),
		venue({ name: 'Ccc Diner', latitude: 43.62, longitude: -79.42 })
	]);
	await insertFoods(db, [{ location_id: withMenu, item_name: 'Soup', price: 5 }]);
	// A fourth venue far away, in a different cell — kept on its own.
	const [far] = await insertLocations(db, [
		venue({ name: 'Ddd Cafe', category: 'cafe', latitude: 49.2, longitude: -123.1 })
	]);

	const bounds = { minLat: 40, maxLat: 50, minLng: -130, maxLng: -70 };
	const { level, cells, data } = await fetchViewport(db, bounds);
	expect(level).toBeGreaterThanOrEqual(MIN_REP_LEVEL);

	// The clustered three collapse to the menu'd one; the far one survives alone.
	expect(data.locations.map((l) => l.id).toSorted()).toEqual([withMenu, far].toSorted());

	// EVERY requested cell is present in the membership record — the occupied two
	// carrying their winner, the rest as the negative [] entries.
	expect(Object.keys(data.cells).length).toBe(cells.length);
	const occupied = Object.entries(data.cells).filter(([, ids]) => ids.length > 0);
	expect(
		occupied
			.map(([, ids]) => ids)
			.flat()
			.toSorted()
	).toEqual([withMenu, far].toSorted());
	expect(occupied.every(([, ids]) => ids.length === 1)).toBe(true);
});

test('likes break representative ties, probed per-candidate (not via a whole-table scan)', async () => {
	const db = freshDb();
	const [, liked] = await insertLocations(db, [
		venue({ name: 'Aaa Unliked', latitude: 43.6, longitude: -79.4 }),
		venue({ name: 'Zzz Liked', latitude: 43.61, longitude: -79.41 })
	]);
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();
	await setLocationLike(db, 'u1', liked, true, 123);

	const { data } = await fetchViewport(db, { minLat: 40, maxLat: 50, minLng: -85, maxLng: -75 });
	// Neither has a menu; the liked one outranks the alphabetically-first one.
	expect(data.locations.map((l) => l.id)).toEqual([liked]);
});

test('the full level returns whole cells — menus, overrides — and caps per cell', async () => {
	const db = freshDb();
	// A neighbourhood viewport (span ~0.02°) → level 0, FULL_CELL_DEG tiles.
	const bounds = { minLat: 49.27, maxLat: 49.29, minLng: -123.13, maxLng: -123.11 };
	expect(levelForBounds(bounds)).toBe(0);

	const [a, b] = await insertLocations(db, [
		venue({ name: 'Green Spot', latitude: 49.28, longitude: -123.12 }),
		venue({ name: 'Plain Diner', latitude: 49.281, longitude: -123.121 })
	]);
	await insertFoods(db, [
		{ location_id: a, item_name: 'Tofu Bowl', tags: ['vegan'], price: 10 },
		{ location_id: b, item_name: 'Burger', price: 9 }
	]);

	const { cells, data } = await fetchViewport(db, bounds);
	// A rep level would keep one venue per cell; the full level keeps both, each
	// with its private menu shipped under its menu id.
	expect(data.locations.map((l) => l.id).toSorted()).toEqual([a, b].toSorted());
	expect(Object.keys(data.menus).toSorted()).toEqual([`pm-${a}`, `pm-${b}`].toSorted());
	expect(data.menus[`pm-${a}`].map((i) => i.item_name)).toEqual(['Tofu Bowl']);
	// The lean shape (#83): no detail fields on the bulk read.
	expect('price' in data.menus[`pm-${a}`][0]).toBe(false);
	expect(Object.keys(data.cells).length).toBe(cells.length);

	// Cap: flood one tile past FULL_CELL_CAP; menu'd venues must survive the cut.
	const flood = Array.from({ length: FULL_CELL_CAP + 10 }, (_, k) =>
		venue({
			name: `Flood ${String(k).padStart(3, '0')}`,
			latitude: 49.301 + 0.0001 * k,
			longitude: -123.119
		})
	);
	await insertLocations(db, flood);
	const floodBounds = { minLat: 49.3, maxLat: 49.32, minLng: -123.13, maxLng: -123.11 };
	const { data: capped } = await fetchViewport(db, floodBounds);
	const tileKey = cellKey(Math.floor((49.301 + 90) / 0.02), Math.floor((-123.119 + 180) / 0.02));
	expect(capped.cells[tileKey].length).toBe(FULL_CELL_CAP);
});

test('cell contents are batch-independent: the same cell answers alone or alongside others', async () => {
	const db = freshDb();
	await insertLocations(db, [
		venue({ name: 'Solo Spot', latitude: 43.6, longitude: -79.4 }),
		venue({ name: 'Other Town', latitude: 45.6, longitude: -75.7 })
	]);
	const level = MIN_REP_LEVEL + 6; // some mid ladder rung
	const cell = levelCell(level);
	const target: [number, number] = [
		Math.floor((43.6 + 90) / cell),
		Math.floor((-79.4 + 180) / cell)
	];
	const other: [number, number] = [
		Math.floor((45.6 + 90) / cell),
		Math.floor((-75.7 + 180) / cell)
	];

	const alone = await getMapCellsData(db, level, [target]);
	const together = await getMapCellsData(db, level, [target, other]);
	expect(together.cells[cellKey(target[0], target[1])]).toEqual(
		alone.cells[cellKey(target[0], target[1])]
	);
	expect(alone.locations.length).toBe(1);
	expect(together.locations.length).toBe(2);
});

test('closed venues never appear in any cell', async () => {
	const db = freshDb();
	const [openId] = await insertLocations(db, [
		venue({ name: 'Open Spot', latitude: 49.2, longitude: -123.1 }),
		venue({
			name: 'Closed Spot',
			latitude: 49.21,
			longitude: -123.11,
			closed_at: 1_700_000_000_000,
			closed_reason: 'Permanently closed per Yelp + dead website'
		})
	]);
	const { data } = await fetchViewport(db, {
		minLat: 49.0,
		maxLat: 49.5,
		minLng: -123.5,
		maxLng: -123.0
	});
	expect(data.locations.map((l) => l.id)).toEqual([openId]);
});

test('splitCellSlices → assembleCellsData round-trips the wire payload', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [
		venue({ name: 'Green Spot', latitude: 49.28, longitude: -123.12 }),
		venue({ name: 'Plain Diner', latitude: 49.19, longitude: -123.01 })
	]);
	await insertFoods(db, [{ location_id: a, item_name: 'Tofu Bowl', tags: ['vegan'], price: 10 }]);

	const { data } = await fetchViewport(db, {
		minLat: 49.0,
		maxLat: 49.5,
		minLng: -123.5,
		maxLng: -123.0
	});
	const slices = splitCellSlices(data);
	// Every requested cell has a slice; empty cells carry empty slices.
	expect(slices.size).toBe(Object.keys(data.cells).length);

	const rebuilt = assembleCellsData(slices);
	expect(rebuilt.cells).toEqual(data.cells);
	expect(rebuilt.locations.map((l) => l.id).toSorted()).toEqual(
		data.locations.map((l) => l.id).toSorted()
	);
	expect(Object.keys(rebuilt.menus).toSorted()).toEqual(Object.keys(data.menus).toSorted());
	expect(rebuilt.menuMeta).toEqual(data.menuMeta);

	// Merging a subset of slices keeps each slice self-contained: a cell's
	// locations always travel with the menus they reference.
	for (const slice of slices.values()) {
		const merged = mergeCellSlices([slice]);
		for (const loc of merged.locations) {
			if (loc.menu_id !== null) expect(merged.menus[loc.menu_id]).toBeDefined();
		}
	}
});

test('CellStore: TTL expiry and LRU eviction', () => {
	let now = 0;
	const store = new CellStore(() => now);
	const slice = { locations: [], menus: {}, menuMeta: {} };

	store.set('6/1:1', slice);
	expect(store.get('6/1:1')).toBe(slice);
	now = CELL_TTL_MS - 1;
	expect(store.get('6/1:1')).toBe(slice);
	now = CELL_TTL_MS;
	expect(store.get('6/1:1')).toBeNull();

	// LRU: fill past the cap; the least-recently-used key is evicted first.
	now = 0;
	for (let k = 0; k < CELL_STORE_MAX; k++) store.set(`6/${k}:0`, slice);
	expect(store.get('6/0:0')).toBe(slice); // refresh 0's recency
	store.set('6/overflow:0', slice); // evicts 1:0, not 0:0
	expect(store.get('6/0:0')).toBe(slice);
	expect(store.get('6/1:0')).toBeNull();
	expect(store.get('6/overflow:0')).toBe(slice);
});

// The wire payload is JSON-serializable end-to-end (the server cache stores
// JSON.stringify'd slices) — no Dates/Maps/undefined may sneak into MapData.
test('cell payloads survive a JSON round trip', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [
		venue({ name: 'Green Spot', latitude: 49.28, longitude: -123.12 })
	]);
	await insertFoods(db, [{ location_id: a, item_name: 'Tofu Bowl', tags: ['vegan'], price: 10 }]);
	const { data } = await fetchViewport(db, {
		minLat: 49.27,
		maxLat: 49.29,
		minLng: -123.13,
		maxLng: -123.11
	});
	const roundTripped = JSON.parse(JSON.stringify(data)) as MapCellsData;
	expect(roundTripped).toEqual(data);
});

// A menu with zero items still has a menuMeta row (the menus-table read) even
// though `menus` (built from item rows) has no entry — the per-cell slicing
// must keep that meta so the venue's "Verified" footer survives.
test('an item-less menu keeps its menuMeta through slicing', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Empty Menu Co', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'Empty Menu CA', region: 'CA' });
	await insertLocations(db, [
		venue({
			name: 'Branch One',
			latitude: 49.28,
			longitude: -123.12,
			brand_id: brandId,
			menu_id: menuId
		})
	]);
	const { data } = await fetchViewport(db, {
		minLat: 49.27,
		maxLat: 49.29,
		minLng: -123.13,
		maxLng: -123.11
	});
	expect(data.menuMeta[menuId]).toBeDefined();
	expect(data.menus[menuId]).toBeUndefined();
	const slices = splitCellSlices(data);
	const withLoc = [...slices.values()].find((slice) => slice.locations.length > 0);
	expect(withLoc?.menuMeta[menuId]).toBeDefined();
});
