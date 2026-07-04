/// <reference types="bun-types" />
// Tests insertLocations (the batch behind the create_locations MCP tool) against
// a real SQLite schema via an in-memory bun:sqlite-backed D1Like adapter — so the
// actual INSERT SQL and all-or-nothing semantics are exercised without touching
// the production D1.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	locationInsertStatementCount,
	chunkLocationInserts,
	getLocationById,
	getFoodByLocation,
	getMenuById,
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

test('insertLocations writes a batch with menu sources and chain links', async () => {
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
			website: null,
			// Provenance is menu-level: the venue's sources ride on its private menu, created from these items.
			menuSources: [{ url: 'https://independent.example/menu', label: 'Menu' }],
			items: [{ item_name: 'Latte', price: 4.5 }]
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
			menu_id: 'menu-1'
		}
	]);
	expect(ids).toHaveLength(2);

	const independent = await getLocationById(db, ids[0]);
	expect(independent?.name).toBe('Independent Spot');
	expect(independent?.brand_id).toBeNull();
	// The single-line address is derived from the structured parts on read.
	expect(independent?.address).toBe('1 Test St, Vancouver, BC V6J 1M5');
	// The venue's sources live on its auto-created private menu.
	const privateMenu = await getMenuById(db, `pm-${ids[0]}`);
	expect(privateMenu?.sources).toEqual([
		{ url: 'https://independent.example/menu', label: 'Menu' }
	]);

	const kfc = await getLocationById(db, ids[1]);
	expect(kfc?.name).toBe('KFC');
	expect(kfc?.category).toBe('fast_food');
	expect(kfc?.brand_id).toBe('brand-1');
	expect(kfc?.menu_id).toBe('menu-1');
	expect(kfc?.street).toBe('123 Yonge St');
	expect(kfc?.region).toBe('ON');
	expect(kfc?.address).toBe('123 Yonge St, Toronto, ON M5C 2K1');
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

// ---------------------------------------------------------------------------
// Statement-bounded chunking (#89): create_locations splits its insert into
// insertLocations calls of at most ~MAX statements at LOCATION boundaries.
// ---------------------------------------------------------------------------

/** An independent venue with `nItems` inline items (each carrying tags) + one menu source. */
function venueWithItems(name: string, i: number, nItems: number) {
	return {
		name,
		category: 'restaurant' as const,
		latitude: 49 + i * 0.001,
		longitude: -123 - i * 0.001,
		...ADDR,
		phone: null,
		website: null,
		// Provenance is menu-level: sources ride on the private menu (only written when items exist).
		menuSources: [{ url: `https://example.com/${name}/menu`, label: null }],
		items: Array.from({ length: nItems }, (_, j) => ({
			item_name: `Dish ${j}`,
			price: 10,
			tags: ['vegan' as const],
			optionalTags: ['gluten_free' as const]
		}))
	};
}

test('locationInsertStatementCount matches the statements insertLocations actually issues', async () => {
	const inner = freshDb();
	const batchSizes: number[] = [];
	const counting = {
		prepare: (sql: string) => inner.prepare(sql),
		batch: (stmts: Parameters<typeof inner.batch>[0]) => {
			batchSizes.push(stmts.length);
			return inner.batch(stmts);
		}
	};
	const cases = [
		// bare venue (no menu): 1 location row (menuSources are ignored without items)
		[venueWithItems('Bare', 0, 0)].map((l) => ({ ...l, menuSources: undefined, items: undefined })),
		// venue with a menu source but no items: still just the 1 location row (no menu created)
		[venueWithItems('Sourced', 1, 0)].map((l) => ({ ...l, items: undefined })),
		// venue + private menu + 1 menu source + 3 items × (row + tag + optional tag): 3 + 9
		[venueWithItems('Full', 2, 3)],
		// two venues in one batch: counts add
		[venueWithItems('A', 3, 1), venueWithItems('B', 4, 2)]
	];
	for (const locs of cases) {
		batchSizes.length = 0;
		await insertLocations(counting, locs);
		const expected = locs.reduce((n, l) => n + locationInsertStatementCount(l), 0);
		expect(batchSizes).toEqual([expected]);
	}
});

test('chunkLocationInserts splits at location boundaries under the statement cap', () => {
	// Each venue is 1 (menu) + 1 (menu source) + 1 (location) + 4×(1+1+1) = 15 statements.
	const locs = Array.from({ length: 10 }, (_, i) => venueWithItems(`V${i}`, i, 4));
	const per = locationInsertStatementCount(locs[0]);
	expect(per).toBe(15);
	const chunks = chunkLocationInserts(locs, 45); // 3 venues (45) fit, a 4th (60) would not
	expect(chunks.map((c) => c.length)).toEqual([3, 3, 3, 1]);
	// Order preserved: concatenating the chunks reproduces the input.
	expect(chunks.flat()).toEqual(locs);
	for (const chunk of chunks) {
		expect(chunk.reduce((n, l) => n + locationInsertStatementCount(l), 0)).toBeLessThanOrEqual(45);
	}
});

test('a single location over the cap gets its own chunk rather than being split', () => {
	const big = venueWithItems('Big Menu', 0, 50); // 3 + 150 statements, way over any cap
	const small = venueWithItems('Small', 1, 1);
	const chunks = chunkLocationInserts([small, big, small], 20);
	expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
	expect(chunks[1][0]).toBe(big);
});

test('chunked insertLocations calls write every location and item', async () => {
	const db = freshDb();
	const locs = Array.from({ length: 7 }, (_, i) => venueWithItems(`Chunked ${i}`, i, 3));
	const ids: string[] = [];
	for (const chunk of chunkLocationInserts(locs, 25)) {
		ids.push(...(await insertLocations(db, chunk)));
	}
	expect(ids).toHaveLength(7);
	for (const id of ids) {
		expect((await getFoodByLocation(db, id)).length).toBe(3);
	}
});
