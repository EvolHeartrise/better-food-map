/// <reference types="bun-types" />
// Shared test harness: an in-memory bun:sqlite adapter implementing the D1Like
// interface, so db.ts can be exercised against the real migration schema (the
// actual SQL and all-or-nothing batch semantics) without touching the production
// D1. Imported by the db-layer test files; not a test file itself.

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Like, D1PreparedLike } from '../src/lib/server/db';

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
export class TestD1 implements D1Like {
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

/** A fresh in-memory database with both migrations applied. */
export function freshDb(): TestD1 {
	const db = new Database(':memory:');
	db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
	db.exec(readFileSync('migrations/0002_chains.sql', 'utf8'));
	db.exec(readFileSync('migrations/0003_location_coords_index.sql', 'utf8'));
	db.exec(readFileSync('migrations/0004_unify_items_and_tags.sql', 'utf8'));
	db.exec(readFileSync('migrations/0005_require_address.sql', 'utf8'));
	db.exec(readFileSync('migrations/0006_tag_search_index.sql', 'utf8'));
	db.exec(readFileSync('migrations/0007_users_likes_searches.sql', 'utf8'));
	db.exec(readFileSync('migrations/0008_location_address_parts.sql', 'utf8'));
	db.exec(readFileSync('migrations/0009_require_address_parts.sql', 'utf8'));
	return new TestD1(db);
}
