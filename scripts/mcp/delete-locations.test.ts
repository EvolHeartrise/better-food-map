/// <reference types="bun-types" />
// Tests deleteLocationsBatch — the delete_locations tool's core: hard-delete a
// batch of location ids, partitioning them into deleted vs not-found. Runs against
// the real migration schema via the in-memory D1 adapter.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	getLocationById,
	insertBrand,
	insertMenu,
	getMenuById,
	type D1Like
} from '../../src/lib/server/db';
import { freshDb } from '../test-d1';
import { deleteLocationsBatch } from './delete-locations';

function loc(over: Record<string, unknown> = {}) {
	return {
		name: 'X',
		category: 'cafe' as const,
		latitude: 49.28,
		longitude: -123.12,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: null,
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

test('deletes existing ids and reports missing ones', async () => {
	const db = freshDb();
	const [a, b] = await insertLocations(db, [loc({ latitude: 49.1 }), loc({ latitude: 49.2 })]);

	const res = await deleteLocationsBatch(db, [a, 'missing-id', b]);
	expect(res.deleted).toBe(2);
	expect(res.deleted_ids.toSorted()).toEqual([a, b].toSorted());
	expect(res.not_found_ids).toEqual(['missing-id']);

	// Both rows are actually gone.
	expect(await getLocationById(db, a)).toBeNull();
	expect(await getLocationById(db, b)).toBeNull();
});

test('a repeated id lands in exactly one bucket (deduped)', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [loc()]);
	const res = await deleteLocationsBatch(db, [a, a]);
	expect(res.deleted).toBe(1);
	expect(res.deleted_ids).toEqual([a]);
	expect(res.not_found_ids).toEqual([]);
});

/** Row count of `table` filtered by one column value. */
async function countWhere(db: D1Like, table: string, col: string, value: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
		.bind(value)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

test('deleting an independent venue removes its private menu, items, tag links and sources', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [
		loc({
			items: [
				{ item_name: 'Vegan Burger', tags: ['vegan'], price: 12 },
				{ item_name: 'Fries', price: 4 }
			],
			menuSources: [{ url: 'https://example.com/menu', label: 'Official menu' }]
		})
	]);
	const menuId = `pm-${a}`;
	// Preconditions: the private menu and its dependents exist.
	expect(await getMenuById(db, menuId)).not.toBeNull();
	expect(await countWhere(db, 'items', 'menu_id', menuId)).toBe(2);
	expect(await countWhere(db, 'menu_sources', 'menu_id', menuId)).toBe(1);
	const before = await db.prepare(`SELECT COUNT(*) AS n FROM item_tags`).first<{ n: number }>();
	expect(before?.n ?? 0).toBeGreaterThan(0);

	const res = await deleteLocationsBatch(db, [a]);
	expect(res.deleted).toBe(1);
	expect(await getLocationById(db, a)).toBeNull();
	expect(await getMenuById(db, menuId)).toBeNull();
	expect(await countWhere(db, 'items', 'menu_id', menuId)).toBe(0);
	expect(await countWhere(db, 'menu_sources', 'menu_id', menuId)).toBe(0);
	const after = await db.prepare(`SELECT COUNT(*) AS n FROM item_tags`).first<{ n: number }>();
	expect(after?.n ?? 0).toBe(0);
});

test('deleting a chain branch leaves the shared brand menu and its items intact', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'Testy Burger', website: null, logo_url: null });
	const menuId = await insertMenu(db, {
		brand_id: brandId,
		name: 'Testy Burger Canada',
		region: 'Canada',
		sources: [{ url: 'https://example.com/chain-menu', label: null }]
	});
	const [branchA, branchB] = await insertLocations(db, [
		loc({ brand_id: brandId, menu_id: menuId, latitude: 49.1 }),
		loc({ brand_id: brandId, menu_id: menuId, latitude: 49.2 })
	]);

	const res = await deleteLocationsBatch(db, [branchA]);
	expect(res.deleted).toBe(1);
	expect(await getMenuById(db, menuId)).not.toBeNull();
	expect(await countWhere(db, 'menu_sources', 'menu_id', menuId)).toBe(1);
	expect(await getLocationById(db, branchB)).not.toBeNull();
});

test('a private menu still referenced by another location survives the delete', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [loc({ items: [{ item_name: 'Latte' }] })]);
	const menuId = `pm-${a}`;
	// A second location pointed at the same private menu (defensive: not a state the
	// MCP write path produces, but the guard must hold if it ever exists).
	const [b] = await insertLocations(db, [loc({ menu_id: menuId, latitude: 49.9 })]);

	const res = await deleteLocationsBatch(db, [a]);
	expect(res.deleted).toBe(1);
	expect(await getLocationById(db, a)).toBeNull();
	// The menu (and its items) survive because `b` still serves it.
	expect(await getMenuById(db, menuId)).not.toBeNull();
	expect(await countWhere(db, 'items', 'menu_id', menuId)).toBe(1);
	expect(await getLocationById(db, b)).not.toBeNull();

	// Deleting the last referencing location then removes the menu too.
	await deleteLocationsBatch(db, [b]);
	expect(await getMenuById(db, menuId)).toBeNull();
	expect(await countWhere(db, 'items', 'menu_id', menuId)).toBe(0);
});
