/// <reference types="bun-types" />
// Tests insertLocations (the batch behind the create_locations MCP tool) against
// a real SQLite schema via an in-memory bun:sqlite-backed D1Like adapter — so the
// actual INSERT SQL and all-or-nothing semantics are exercised without touching
// the production D1.

import { test, expect } from 'bun:test';
import { insertLocations, getLocationById } from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('insertLocations writes a batch with sources and chain links', async () => {
	const db = freshDb();
	const ids = await insertLocations(db, [
		{
			name: 'Independent Spot',
			category: 'cafe',
			latitude: 49.28,
			longitude: -123.12,
			address: '1 Test St',
			phone: null,
			website: null
		},
		{
			name: 'KFC',
			category: 'fast_food',
			latitude: 43.65,
			longitude: -79.38,
			address: '123 Yonge St',
			phone: null,
			website: 'https://www.kfc.ca',
			brand_id: 'brand-1',
			menu_id: 'menu-1',
			sources: [{ url: 'https://www.openstreetmap.org/node/1', label: 'OpenStreetMap' }]
		}
	]);
	expect(ids).toHaveLength(2);

	const independent = await getLocationById(db, ids[0]);
	expect(independent?.name).toBe('Independent Spot');
	expect(independent?.brand_id).toBeNull();
	expect(independent?.sources).toEqual([]);

	const kfc = await getLocationById(db, ids[1]);
	expect(kfc?.name).toBe('KFC');
	expect(kfc?.category).toBe('fast_food');
	expect(kfc?.brand_id).toBe('brand-1');
	expect(kfc?.menu_id).toBe('menu-1');
	expect(kfc?.address).toBe('123 Yonge St');
	expect(kfc?.sources).toEqual([
		{ url: 'https://www.openstreetmap.org/node/1', label: 'OpenStreetMap' }
	]);
});

test('insertLocations honours explicit ids and returns them in order', async () => {
	const db = freshDb();
	const ids = await insertLocations(db, [
		{
			id: 'a',
			name: 'A',
			category: null,
			latitude: 1,
			longitude: 1,
			address: '1 Test St',
			phone: null,
			website: null
		},
		{
			id: 'b',
			name: 'B',
			category: null,
			latitude: 2,
			longitude: 2,
			address: '1 Test St',
			phone: null,
			website: null
		}
	]);
	expect(ids).toEqual(['a', 'b']);
});

test('insertLocations is all-or-nothing: a duplicate id rolls back the whole batch', async () => {
	const db = freshDb();
	await insertLocations(db, [
		{
			id: 'dup',
			name: 'First',
			category: null,
			latitude: 1,
			longitude: 1,
			address: '1 Test St',
			phone: null,
			website: null
		}
	]);

	let threw = false;
	try {
		await insertLocations(db, [
			{
				id: 'fresh',
				name: 'Would-be new',
				category: null,
				latitude: 3,
				longitude: 3,
				address: '1 Test St',
				phone: null,
				website: null
			},
			{
				id: 'dup',
				name: 'Collides',
				category: null,
				latitude: 4,
				longitude: 4,
				address: '1 Test St',
				phone: null,
				website: null
			}
		]);
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	// The valid first item of the failed batch must NOT have been written.
	expect(await getLocationById(db, 'fresh')).toBeNull();
});

test('a null or blank address is rejected by the DB constraint (migration 0005)', async () => {
	const db = freshDb();
	for (const bad of [null, '', '   '] as const) {
		let threw = false;
		try {
			await insertLocations(db, [
				{
					name: 'No Address',
					category: null,
					latitude: 1,
					longitude: 1,
					address: bad,
					phone: null,
					website: null
				}
			]);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	}
	// A trailing-field update that blanks the address is rejected too.
	const [id] = await insertLocations(db, [
		{
			name: 'Has Address',
			category: null,
			latitude: 1,
			longitude: 1,
			address: '5 Real Rd',
			phone: null,
			website: null
		}
	]);
	let updateThrew = false;
	try {
		await db.prepare('UPDATE locations SET address = ? WHERE id = ?').bind('', id).run();
	} catch {
		updateThrew = true;
	}
	expect(updateThrew).toBe(true);
});
