/// <reference types="bun-types" />
// Tests insertLocations (the batch behind the create_locations MCP tool) against
// a real SQLite schema via an in-memory bun:sqlite-backed D1Like adapter — so the
// actual INSERT SQL and all-or-nothing semantics are exercised without touching
// the production D1.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	getLocationById,
	getFoodByLocation,
	insertBrand,
	insertMenu
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

/** Structured address parts shared by fixtures (all required parts present). */
const ADDR = {
	street: '1 Test St',
	city: 'Vancouver',
	region: 'BC',
	postcode: 'V6J 1M5',
	country: 'CA'
};

test('insertLocations writes a batch with sources and chain links', async () => {
	const db = freshDb();
	// Real parent rows: the harness enforces foreign keys like production D1.
	await insertBrand(db, { id: 'brand-1', name: 'KFC', website: null, logo_url: null });
	await insertMenu(db, { id: 'menu-1', brand_id: 'brand-1', name: 'KFC Canada', region: 'CA' });
	const ids = await insertLocations(db, [
		{
			name: 'Independent Spot',
			category: 'cafe',
			latitude: 49.28,
			longitude: -123.12,
			...ADDR,
			phone: null,
			website: null
		},
		{
			name: 'KFC',
			category: 'fast_food',
			latitude: 43.65,
			longitude: -79.38,
			street: '123 Yonge St',
			city: 'Toronto',
			region: 'ON',
			postcode: 'M5C 2K1',
			country: 'CA',
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
	// The single-line address is derived from the structured parts on read.
	expect(independent?.address).toBe('1 Test St, Vancouver, BC V6J 1M5');

	const kfc = await getLocationById(db, ids[1]);
	expect(kfc?.name).toBe('KFC');
	expect(kfc?.category).toBe('fast_food');
	expect(kfc?.brand_id).toBe('brand-1');
	expect(kfc?.menu_id).toBe('menu-1');
	expect(kfc?.street).toBe('123 Yonge St');
	expect(kfc?.region).toBe('ON');
	expect(kfc?.address).toBe('123 Yonge St, Toronto, ON M5C 2K1');
	expect(kfc?.sources).toEqual([
		{ url: 'https://www.openstreetmap.org/node/1', label: 'OpenStreetMap' }
	]);
});

test('a null postcode is allowed and omitted from the display line', async () => {
	const db = freshDb();
	const [id] = await insertLocations(db, [
		{
			name: 'No Postcode',
			category: null,
			latitude: 1,
			longitude: 1,
			street: '100 Bayshore Dr',
			city: 'Ottawa',
			region: 'ON',
			postcode: null,
			country: 'CA',
			phone: null,
			website: null
		}
	]);
	const loc = await getLocationById(db, id);
	expect(loc?.postcode).toBeNull();
	expect(loc?.address).toBe('100 Bayshore Dr, Ottawa, ON');
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
			...ADDR,
			phone: null,
			website: null
		},
		{
			id: 'b',
			name: 'B',
			category: null,
			latitude: 2,
			longitude: 2,
			...ADDR,
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
			...ADDR,
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
				...ADDR,
				phone: null,
				website: null
			},
			{
				id: 'dup',
				name: 'Collides',
				category: null,
				latitude: 4,
				longitude: 4,
				...ADDR,
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

test('a missing required address part is rejected by the DB triggers (migration 0009)', async () => {
	const db = freshDb();
	// Each required part, blanked in turn, must abort the insert.
	const required = ['street', 'city', 'region', 'country'] as const;
	for (const part of required) {
		for (const bad of ['', '   '] as const) {
			let threw = false;
			try {
				await insertLocations(db, [
					{
						name: 'Bad',
						category: null,
						latitude: 1,
						longitude: 1,
						...ADDR,
						[part]: bad,
						phone: null,
						website: null
					}
				]);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		}
	}

	// A trailing-field update that blanks a required part is rejected too.
	const [id] = await insertLocations(db, [
		{
			name: 'Has Address',
			category: null,
			latitude: 1,
			longitude: 1,
			...ADDR,
			phone: null,
			website: null
		}
	]);
	let updateThrew = false;
	try {
		await db.prepare('UPDATE locations SET region = ? WHERE id = ?').bind('', id).run();
	} catch {
		updateThrew = true;
	}
	expect(updateThrew).toBe(true);
});

test('insertLocations creates an independent venue and its own menu in one batch', async () => {
	const db = freshDb();
	const [id] = await insertLocations(db, [
		{
			name: 'Inline Menu Cafe',
			category: 'cafe',
			latitude: 49.28,
			longitude: -123.12,
			...ADDR,
			phone: null,
			website: null,
			items: [
				{ item_name: 'Oat Latte', price: 5, tags: ['vegan'], optionalTags: ['vegetarian'] },
				{ item_name: 'Croissant', price: 3 }
			]
		}
	]);

	// A private menu was created and the location points at it.
	const loc = await getLocationById(db, id);
	expect(loc?.menu_id).toBe(`pm-${id}`);

	const menu = await getFoodByLocation(db, id);
	expect(menu.map((i) => i.item_name).toSorted()).toEqual(['Croissant', 'Oat Latte']);
	const latte = menu.find((i) => i.item_name === 'Oat Latte');
	expect(latte?.price).toBe(5);
	expect(latte?.tags.some((t) => t.id === 'vegan')).toBe(true);
	// An optional dietary tag is stored with optional = true ("can be made vegetarian").
	expect(latte?.tags.find((t) => t.id === 'vegetarian')?.optional).toBe(true);
});

test('insertLocations rejects inline items on a chain branch and writes nothing', async () => {
	const db = freshDb();
	let threw = false;
	try {
		await insertLocations(db, [
			{
				id: 'branch-x',
				name: 'Chain Branch',
				category: 'fast_food',
				latitude: 1,
				longitude: 1,
				...ADDR,
				phone: null,
				website: null,
				brand_id: 'b1',
				menu_id: 'm1',
				items: [{ item_name: 'Not allowed on a shared menu' }]
			}
		]);
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	expect(await getLocationById(db, 'branch-x')).toBeNull();
});
