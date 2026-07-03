/// <reference types="bun-types" />
// Shared test harness: an in-memory bun:sqlite adapter implementing the D1Like
// interface, so db.ts can be exercised against the real migration schema (the
// actual SQL and all-or-nothing batch semantics) without touching the production
// D1. Imported by the db-layer test files; not a test file itself.

import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMapCellsData } from '../src/lib/server/db';
import type { Bounds, D1Like, D1PreparedLike, MapData, SearchFilter } from '../src/lib/server/db';
import { FULL_CELL_DEG, cellsForBounds, levelCell, levelForBounds } from '../src/lib/grid';

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
		// Real D1 returns one `{ results }` object per statement, in statement order,
		// and read-through-batch callers (queryMapData's sub-reads) consume them —
		// so mirror that shape. `.all()` yields `[]` for a statement that returns no
		// rows (writes included), matching D1's empty `results` there.
		const tx = this.db.transaction((stmts: TestStmt[]) =>
			stmts.map((s) => ({ results: this.db.query(s._sql).all(...(s._params as never[])) }))
		);
		return tx(statements as TestStmt[]);
	}
}

/** A fresh in-memory database with every migration in migrations/ applied. */
export function freshDb(): TestD1 {
	const db = new Database(':memory:');
	// Match production D1, which enforces foreign keys by default — otherwise the
	// ON DELETE CASCADE behavior migrations advertise is never exercised in tests.
	db.exec('PRAGMA foreign_keys = ON;');
	for (const f of readdirSync('migrations').toSorted()) {
		if (f.endsWith('.sql')) db.exec(readFileSync(join('migrations', f), 'utf8'));
	}
	return new TestD1(db);
}

/**
 * The browse read for a whole viewport, composed exactly the way the map page
 * composes it (level from the padded box, cells enumerated, one cells read) and
 * merged back to a plain MapData. Test-side stand-in for the removed
 * bounds-shaped getMapData, so viewport-behaviour tests keep exercising the
 * REAL production path — grid selection + getMapCellsData — end to end.
 */
export async function viewportMapData(db: D1Like, bounds: Bounds): Promise<MapData> {
	const level = levelForBounds(bounds);
	const cells = cellsForBounds(bounds, levelCell(level));
	const data = await getMapCellsData(db, level, cells);
	return { locations: data.locations, menus: data.menus, menuMeta: data.menuMeta };
}

/**
 * The SEARCH read over a viewport, at the FULL level so no per-cell
 * representative trimming thins the matches — the shape membership tests need:
 * "every venue in `bounds` matching `filter`". Exercises the real production
 * filter path (searchMembership inside getMapCellsData); rep-level trimming
 * under a filter is covered by its own tests in map-cells.test.ts.
 */
export async function searchMapData(
	db: D1Like,
	bounds: Bounds,
	filter: SearchFilter
): Promise<MapData> {
	const cells = cellsForBounds(bounds, FULL_CELL_DEG);
	const data = await getMapCellsData(db, 0, cells, filter);
	return { locations: data.locations, menus: data.menus, menuMeta: data.menuMeta };
}
