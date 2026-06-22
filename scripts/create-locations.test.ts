/// <reference types="bun-types" />
// Tests insertLocations (the batch behind the create_locations MCP tool) against
// a real SQLite schema via an in-memory bun:sqlite-backed D1Like adapter — so the
// actual INSERT SQL and all-or-nothing semantics are exercised without touching
// the production D1.

import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import {
	insertLocations,
	getLocationById,
	type D1Like,
	type D1PreparedLike
} from '../src/lib/server/db';

class TestStmt implements D1PreparedLike {
	params: unknown[] = [];
	constructor(
		private readonly db: Database,
		private readonly sql: string
	) {}
	bind(...values: unknown[]): D1PreparedLike {
		const next = new TestStmt(this.db, this.sql);
		next.params = values;
		return next;
	}
	async first<T>(): Promise<T | null> {
		return (this.db.query(this.sql).get(...(this.params as never[])) as T) ?? null;
	}
	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[] };
	}
	async run(): Promise<{ meta: { changes: number } }> {
		const r = this.db.query(this.sql).run(...(this.params as never[]));
		return { meta: { changes: Number(r.changes) } };
	}
	get _sql(): string {
		return this.sql;
	}
	get _params(): unknown[] {
		return this.params;
	}
}

/** Minimal D1Like over bun:sqlite; batch runs statements in one transaction. */
class TestD1 implements D1Like {
	constructor(private readonly db: Database) {}
	prepare(sql: string): D1PreparedLike {
		return new TestStmt(this.db, sql);
	}
	async batch(statements: D1PreparedLike[]): Promise<unknown[]> {
		const tx = this.db.transaction((stmts: TestStmt[]) => {
			for (const s of stmts) this.db.query(s._sql).run(...(s._params as never[]));
		});
		tx(statements as TestStmt[]);
		return [];
	}
}

function freshDb(): TestD1 {
	const db = new Database(':memory:');
	db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
	db.exec(readFileSync('migrations/0002_chains.sql', 'utf8'));
	return new TestD1(db);
}

test('insertLocations writes a batch with sources and chain links', async () => {
	const db = freshDb();
	const ids = await insertLocations(db, [
		{
			name: 'Independent Spot',
			category: 'cafe',
			latitude: 49.28,
			longitude: -123.12,
			address: null,
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
			address: null,
			phone: null,
			website: null
		},
		{
			id: 'b',
			name: 'B',
			category: null,
			latitude: 2,
			longitude: 2,
			address: null,
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
			address: null,
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
				address: null,
				phone: null,
				website: null
			},
			{
				id: 'dup',
				name: 'Collides',
				category: null,
				latitude: 4,
				longitude: 4,
				address: null,
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
