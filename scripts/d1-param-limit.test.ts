/// <reference types="bun-types" />
// Regression tests for D1's ~100 bound-parameter-per-query cap. The batch helpers
// (existingIds, existingLocationsAtCoords, the updateLocations/updateItems existence
// checks, itemNameCollisions) used to expand one `?` per value — so an MCP batch past
// the cap (update_items allows 200 patches; a 100-location create_locations batch is
// 200 params at two per coordinate PAIR; a create_items menu is uncapped) failed on
// D1 while passing against local SQLite, whose variable limit is ~32k. Each helper now
// ships its values as ONE JSON-array bind expanded with json_each. These tests drive
// every converted helper past 100 values through an adapter that enforces D1's cap at
// bind time (so plain bun:sqlite can't mask a regression), and pin the two behavioural
// subtleties the rewrite must preserve: itemNameCollisions stays case-insensitive
// (SQLite's IN takes the LEFT operand's collation), and coordinate matching stays
// float-EXACT through the JSON round-trip (the coordinate-identical dedup invariant).

import { test, expect } from 'bun:test';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems,
	existingIds,
	existingLocationsAtCoords,
	coordinateKey,
	itemNameCollisions,
	updateLocations,
	updateItems,
	getLocationById,
	getItemById,
	type D1Like,
	type D1PreparedLike
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

// D1's documented per-query limit on bound parameters.
const D1_MAX_BOUND_PARAMS = 100;

class CappedStmt implements D1PreparedLike {
	constructor(readonly inner: D1PreparedLike) {}
	bind(...values: unknown[]): D1PreparedLike {
		if (values.length > D1_MAX_BOUND_PARAMS) {
			throw new Error(
				`statement binds ${values.length} parameters — over D1's cap of ${D1_MAX_BOUND_PARAMS}`
			);
		}
		return new CappedStmt(this.inner.bind(...values));
	}
	first<T>(): Promise<T | null> {
		return this.inner.first<T>();
	}
	all<T>(): Promise<{ results: T[] }> {
		return this.inner.all<T>();
	}
	run(): Promise<{ meta: { changes: number } }> {
		return this.inner.run();
	}
}

/** {@link freshDb} wrapped to reject any statement that binds more parameters than D1 allows. */
function cappedDb(): D1Like {
	const inner = freshDb();
	return {
		prepare: (query) => new CappedStmt(inner.prepare(query)),
		batch: (statements) => inner.batch(statements.map((s) => (s as CappedStmt).inner))
	};
}

/**
 * High-precision coordinates whose binary64 values have long, irregular fractional
 * expansions — the worst case for any lossy serialization on the way into SQLite.
 */
function coordPair(i: number) {
	return { latitude: 49.28327183 + i * 0.00000137, longitude: -123.12093461 - i * 0.00000731 };
}

function venue(id: string, latitude: number, longitude: number) {
	return {
		id,
		name: `Venue ${id}`,
		category: 'cafe' as const,
		latitude,
		longitude,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null
	};
}

test('existingIds checks 150 ids in one query under the parameter cap', async () => {
	const db = cappedDb();
	const present = Array.from({ length: 120 }, (_, i) => `loc${i}`);
	await insertLocations(
		db,
		present.map((id, i) => venue(id, coordPair(i).latitude, coordPair(i).longitude))
	);
	const ghosts = Array.from({ length: 30 }, (_, i) => `ghost${i}`);
	const found = await existingIds(db, 'locations', [...present, ...ghosts]);
	expect(found).toEqual(new Set(present));
});

test('existingLocationsAtCoords matches 130 coordinate pairs under the parameter cap', async () => {
	const db = cappedDb();
	// 120 pairs alone would be 240 bound parameters under the old two-per-pair scheme.
	const seeded = Array.from({ length: 120 }, (_, i) => coordPair(i));
	await insertLocations(
		db,
		seeded.map((c, i) => venue(`loc${i}`, c.latitude, c.longitude))
	);
	const absent = Array.from({ length: 10 }, (_, i) => coordPair(1000 + i));
	const map = await existingLocationsAtCoords(db, [...seeded, ...absent]);
	expect(map.size).toBe(120);
	for (const [i, c] of seeded.entries()) {
		expect(map.get(coordinateKey(c.latitude, c.longitude))?.id).toBe(`loc${i}`);
	}
	for (const c of absent) {
		expect(map.has(coordinateKey(c.latitude, c.longitude))).toBe(false);
	}
});

test('coordinate matching stays float-exact through the JSON round-trip', async () => {
	const db = cappedDb();
	await insertLocations(db, [
		venue('exact', 49.28327183, -123.12093461),
		// Integer-valued coordinates serialize without a fraction ("49"); SQLite's
		// numeric comparison must still equate them with the stored REAL.
		venue('whole', 49, -123)
	]);
	const hits = await existingLocationsAtCoords(db, [
		{ latitude: 49.28327183, longitude: -123.12093461 },
		{ latitude: 49, longitude: -123 }
	]);
	expect(hits.get(coordinateKey(49.28327183, -123.12093461))?.id).toBe('exact');
	expect(hits.get(coordinateKey(49, -123))?.id).toBe('whole');
	// One step off in the 8th decimal (~1 mm) must NOT match: the dedup invariant is
	// coordinate-IDENTICAL equality, never proximity (see the OSM coordinate policy).
	const miss = await existingLocationsAtCoords(db, [
		{ latitude: 49.28327184, longitude: -123.12093461 }
	]);
	expect(miss.size).toBe(0);
});

test('updateLocations resolves 150 patch ids in one existence check', async () => {
	const db = cappedDb();
	const present = Array.from({ length: 110 }, (_, i) => `loc${i}`);
	await insertLocations(
		db,
		present.map((id, i) => venue(id, coordPair(i).latitude, coordPair(i).longitude))
	);
	const ghosts = Array.from({ length: 40 }, (_, i) => `ghost${i}`);
	const { updatedIds, notFoundIds } = await updateLocations(db, [
		...present.map((id) => ({ id, phone: '604-555-0100' })),
		...ghosts.map((id) => ({ id, phone: '604-555-0100' }))
	]);
	expect(updatedIds).toEqual(present);
	expect(notFoundIds).toEqual(ghosts);
	expect((await getLocationById(db, 'loc0'))?.phone).toBe('604-555-0100');
});

test('itemNameCollisions checks 150 names in one query, still case-insensitively', async () => {
	const db = cappedDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	const existing = Array.from({ length: 40 }, (_, i) => `Signature Dish ${i}`);
	const ids = await insertMenuItems(
		db,
		existing.map((item_name) => ({ menu_id: menuId, item_name }))
	);
	// Query the seeded names in a DIFFERENT case plus 110 novel ones: every seeded
	// name must still collide (reported under the queried spelling), no novel one may.
	const collisions = await itemNameCollisions(db, menuId, [
		...existing.map((n) => n.toUpperCase()),
		...Array.from({ length: 110 }, (_, i) => `Novel Dish ${i}`)
	]);
	expect(collisions).toEqual(
		existing.map((n, i) => ({ item_name: n.toUpperCase(), existing_ids: [ids[i]] }))
	);
});

test('updateItems resolves 150 patch ids in one existence check', async () => {
	const db = cappedDb();
	const brandId = await insertBrand(db, { name: 'B', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'M' });
	const ids = await insertMenuItems(
		db,
		Array.from({ length: 120 }, (_, i) => ({ menu_id: menuId, item_name: `Dish ${i}` }))
	);
	const ghosts = Array.from({ length: 30 }, (_, i) => `ghost${i}`);
	const { updatedIds, notFoundIds } = await updateItems(db, [
		...ids.map((id) => ({ id, price: 9.99 })),
		...ghosts.map((id) => ({ id, price: 9.99 }))
	]);
	expect(updatedIds).toEqual(ids);
	expect(notFoundIds).toEqual(ghosts);
	expect((await getItemById(db, ids[0]))?.price).toBe(9.99);
});
