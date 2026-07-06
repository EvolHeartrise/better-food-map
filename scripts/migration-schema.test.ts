/// <reference types="bun-types" />
// Guards that freshDb() really applies EVERY migration in migrations/ — the
// harness used to hand-list files and silently skipped 0012 and 0017, so the
// invariants those migrations enforce in production were never exercised here.

import { test, expect } from 'bun:test';
import { freshDb } from './test-d1';

async function insertError(db: ReturnType<typeof freshDb>, sql: string, params: unknown[]) {
	try {
		await db
			.prepare(sql)
			.bind(...params)
			.run();
	} catch (e) {
		return e;
	}
	return null;
}

test('0012 trigger: rejects a menu insert with an empty last_verified', async () => {
	const db = freshDb();
	const insert = `INSERT INTO menus (id, name, last_verified) VALUES (?, ?, ?)`;
	for (const bad of [null, '', '  ']) {
		const err = await insertError(db, insert, ['m-bad', 'No Date', bad]);
		expect(String(err)).toContain('last_verified');
	}
	// Sanity: a dated insert passes the trigger.
	await db.prepare(insert).bind('m-ok', 'Dated', '2026-07-02').run();
});

test('0012 trigger: rejects blanking last_verified on update', async () => {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO menus (id, name, last_verified) VALUES (?, ?, ?)`)
		.bind('m1', 'Dated', '2026-07-02')
		.run();
	const err = await insertError(db, `UPDATE menus SET last_verified = NULL WHERE id = ?`, ['m1']);
	expect(String(err)).toContain('last_verified');
});

test('0017 index: sessions.expires_at index exists', async () => {
	const db = freshDb();
	const row = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
		.bind('idx_sessions_expires_at')
		.first<{ name: string }>();
	expect(row?.name).toBe('idx_sessions_expires_at');
});

test('0022 index: items (menu_id, item_name) composite replaces idx_items_menu_id', async () => {
	const db = freshDb();
	const indexByName = (name: string) =>
		db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
			.bind(name)
			.first<{ name: string }>();
	// The old single-column index is dropped…
	expect(await indexByName('idx_items_menu_id')).toBeNull();
	// …and the composite index that satisfies the ORDER BYs exists.
	expect((await indexByName('idx_items_menu_id_name'))?.name).toBe('idx_items_menu_id_name');
});

test('0021: sources are menu-only — location_sources / item_sources are dropped, menu_sources remains', async () => {
	const db = freshDb();
	const tableNames = async (name: string) =>
		db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.bind(name)
			.first<{ name: string }>();
	// The per-location and per-item source tables are gone after migration 0021.
	expect(await tableNames('location_sources')).toBeNull();
	expect(await tableNames('item_sources')).toBeNull();
	// menu_sources is the sole surviving provenance table.
	expect((await tableNames('menu_sources'))?.name).toBe('menu_sources');
});
