/// <reference types="bun-types" />
// Tests the SQL-level filtering of getLocationsWithTags (behind the list_locations
// MCP tool): category/bbox/limit/offset are pushed into the query rather than
// applied after reading the whole table, while the per-location dietary/course tag
// overview still rides along for exactly the rows returned.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	getLocationsWithTags,
	countLocations,
	existingIds,
	type D1Like
} from '../src/lib/server/db';
import { freshDb } from './test-d1';
import {
	resolveListLimit,
	resolveListOffset,
	buildListLocationsPage,
	LIST_LOCATIONS_DEFAULT_LIMIT,
	LIST_LOCATIONS_MAX_LIMIT
} from './mcp/list-locations-page';

const VAN_ADDR = {
	street: '1 Test St',
	city: 'Vancouver',
	region: 'BC',
	postcode: 'V6J 1M5',
	country: 'CA'
};

function seed(db: D1Like): Promise<string[]> {
	return insertLocations(db, [
		{
			id: 'van1',
			name: 'Van Cafe',
			category: 'cafe',
			latitude: 49.28,
			longitude: -123.12,
			...VAN_ADDR,
			phone: null,
			website: null,
			items: [{ item_name: 'Vegan Bowl', tags: ['vegan'] }]
		},
		{
			id: 'van2',
			name: 'Van Bakery',
			category: 'bakery',
			latitude: 49.29,
			longitude: -123.1,
			...VAN_ADDR,
			phone: null,
			website: null
		},
		{
			id: 'tor1',
			name: 'Tor Diner',
			category: 'restaurant',
			latitude: 43.65,
			longitude: -79.38,
			street: '1 King St',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M5C 2K1',
			country: 'CA',
			phone: null,
			website: null
		}
	]);
}

test('getLocationsWithTags filters by category in SQL', async () => {
	const db = freshDb();
	await seed(db);
	const cafes = await getLocationsWithTags(db, { category: 'cafe' });
	expect(cafes.map((l) => l.id)).toEqual(['van1']);
});

test('getLocationsWithTags filters by bbox and still attaches the tag overview', async () => {
	const db = freshDb();
	await seed(db);
	const vancouver = await getLocationsWithTags(db, {
		bbox: { minLat: 49, maxLat: 50, minLng: -124, maxLng: -123 }
	});
	expect(vancouver.map((l) => l.id).toSorted()).toEqual(['van1', 'van2']);
	const cafe = vancouver.find((l) => l.id === 'van1');
	expect(cafe?.tags.some((t) => t.id === 'vegan')).toBe(true);
});

test('getLocationsWithTags pages with limit/offset over the name order', async () => {
	const db = freshDb();
	await seed(db);
	expect((await getLocationsWithTags(db)).map((l) => l.name)).toEqual([
		'Tor Diner',
		'Van Bakery',
		'Van Cafe'
	]);
	expect((await getLocationsWithTags(db, { limit: 2 })).map((l) => l.name)).toEqual([
		'Tor Diner',
		'Van Bakery'
	]);
	expect((await getLocationsWithTags(db, { limit: 2, offset: 1 })).map((l) => l.name)).toEqual([
		'Van Bakery',
		'Van Cafe'
	]);
});

test('getLocationsWithTags with no filter returns every location', async () => {
	const db = freshDb();
	await seed(db);
	expect((await getLocationsWithTags(db)).length).toBe(3);
});

test('getLocationsWithTags filters by nameLike (case-insensitive substring, behind list_locations query)', async () => {
	const db = freshDb();
	await seed(db);
	expect((await getLocationsWithTags(db, { nameLike: 'van' })).map((l) => l.id).toSorted()).toEqual(
		['van1', 'van2']
	);
	// Case-insensitive, and narrows further on a more specific substring.
	expect((await getLocationsWithTags(db, { nameLike: 'CAFE' })).map((l) => l.id)).toEqual(['van1']);
	expect(await getLocationsWithTags(db, { nameLike: 'nomatch' })).toEqual([]);
});

test('getLocationsWithTags combines nameLike with category', async () => {
	const db = freshDb();
	await seed(db);
	// "Van" matches van1 (cafe) and van2 (bakery); category narrows to the bakery.
	expect(
		(await getLocationsWithTags(db, { nameLike: 'Van', category: 'bakery' })).map((l) => l.id)
	).toEqual(['van2']);
});

// --- list_locations paging: cap + has_more truncation signal (Change 1) -----
// The handler over-fetches (limit + 1) rows and hands them to buildListLocationsPage,
// which trims to `limit` and reports has_more — so it never pays a second COUNT.
// These exercise the pure page helpers plus their integration with the SQL read.

test('resolveListLimit/Offset default, clamp to max, and floor', () => {
	expect(resolveListLimit(undefined)).toBe(LIST_LOCATIONS_DEFAULT_LIMIT); // default 50
	expect(resolveListLimit(10)).toBe(10);
	expect(resolveListLimit(9999)).toBe(LIST_LOCATIONS_MAX_LIMIT); // clamped to 200, not rejected
	expect(resolveListLimit(0)).toBe(1); // floored to a valid page
	expect(resolveListOffset(undefined)).toBe(0);
	expect(resolveListOffset(5)).toBe(5);
	expect(resolveListOffset(-3)).toBe(0);
});

test('buildListLocationsPage trims the (limit + 1) probe and sets has_more', () => {
	// One extra row over the limit → truncated: probe trimmed, has_more true.
	const over = buildListLocationsPage([1, 2, 3], 2, 0);
	expect(over.locations).toEqual([1, 2]);
	expect(over.returned).toBe(2);
	expect(over.has_more).toBe(true);
	expect(over.limit).toBe(2);
	expect(over.offset).toBe(0);

	// Exactly `limit` rows came back (no probe) → last page, has_more false.
	const exact = buildListLocationsPage([1, 2], 2, 4);
	expect(exact.locations).toEqual([1, 2]);
	expect(exact.has_more).toBe(false);
	expect(exact.offset).toBe(4);
});

test('the default cap applies and has_more is false when fewer rows than the cap exist', async () => {
	const db = freshDb();
	await seed(db); // 3 locations, well under the default 50
	const effLimit = resolveListLimit(undefined);
	const rows = await getLocationsWithTags(db, { limit: effLimit + 1 });
	const page = buildListLocationsPage(rows, effLimit, resolveListOffset(undefined));
	expect(page.limit).toBe(50);
	expect(page.returned).toBe(3);
	expect(page.has_more).toBe(false);
});

test('has_more is true when more rows exist than the limit, false on the last page', async () => {
	const db = freshDb();
	await seed(db); // 3 locations, name order: Tor Diner, Van Bakery, Van Cafe
	const effLimit = resolveListLimit(2);

	// First page: fetch limit + 1 = 3 rows over 3 total → probe present → has_more.
	const first = buildListLocationsPage(
		await getLocationsWithTags(db, { limit: effLimit + 1, offset: 0 }),
		effLimit,
		0
	);
	expect(first.locations.map((l) => l.name)).toEqual(['Tor Diner', 'Van Bakery']);
	expect(first.has_more).toBe(true);

	// Last page: offset 2 leaves 1 row, fetch 3, get 1 → no probe → has_more false.
	const last = buildListLocationsPage(
		await getLocationsWithTags(db, { limit: effLimit + 1, offset: 2 }),
		effLimit,
		2
	);
	expect(last.locations.map((l) => l.name)).toEqual(['Van Cafe']);
	expect(last.returned).toBe(1);
	expect(last.has_more).toBe(false);
});

test('the count_only path is unchanged (countLocations still returns the bare total)', async () => {
	const db = freshDb();
	await seed(db);
	expect(await countLocations(db)).toBe(3);
	expect(await countLocations(db, { category: 'cafe' })).toBe(1);
	expect(await countLocations(db, { nameLike: 'Van' })).toBe(2);
});

test('existingIds returns only the ids already present (for idempotent retries)', async () => {
	const db = freshDb();
	await seed(db);
	const found = await existingIds(db, 'locations', ['van1', 'ghost', 'tor1']);
	expect([...found].toSorted()).toEqual(['tor1', 'van1']);
	expect(await existingIds(db, 'locations', [])).toEqual(new Set());
	// The interpolated table name is guarded against anything outside the allowlist.
	expect(existingIds(db, 'sqlite_master' as never, ['x'])).rejects.toThrow(/invalid table/);
});
