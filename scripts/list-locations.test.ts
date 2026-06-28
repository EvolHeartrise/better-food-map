/// <reference types="bun-types" />
// Tests the SQL-level filtering of getLocationsWithTags (behind the list_locations
// MCP tool): category/bbox/limit/offset are pushed into the query rather than
// applied after reading the whole table, while the per-location dietary/course tag
// overview still rides along for exactly the rows returned.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	getLocationsWithTags,
	existingIds,
	type D1Like
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

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

test('existingIds returns only the ids already present (for idempotent retries)', async () => {
	const db = freshDb();
	await seed(db);
	const found = await existingIds(db, 'locations', ['van1', 'ghost', 'tor1']);
	expect([...found].toSorted()).toEqual(['tor1', 'van1']);
	expect(await existingIds(db, 'locations', [])).toEqual(new Set());
	// The interpolated table name is guarded against anything outside the allowlist.
	expect(existingIds(db, 'sqlite_master' as never, ['x'])).rejects.toThrow(/invalid table/);
});
