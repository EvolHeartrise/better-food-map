/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// Mirrors the production Cloudflare D1 database into the local one that
// `vite dev` reads, so local development shows real venues/menus.
//
//   bun run db:pull
//
// Why this isn't just `wrangler d1 export --remote`:
//   D1's exporter REFUSES any database that contains an FTS5 virtual table — it
//   errors with "cannot export databases with Virtual Tables (fts5)". The schema
//   has none today (the old `tags_fts` index was dropped in migration 0014), but
//   even a plain per-`--table` export only emits the bare CREATE TABLE + rows for
//   each listed table — every index and trigger is dropped. So we split schema
//   from data regardless, and the virtual-table handling below stays in place so a
//   reintroduced FTS table would still export cleanly:
//
//   1. schema  — read every CREATE verbatim from prod's `sqlite_master`
//                (tables, indexes, triggers, and any FTS5 virtual table). This
//                isn't subject to the exporter's virtual-table refusal.
//   2. data    — `wrangler d1 export --remote --no-schema --table …` (one flag
//                per real table) dumps just the INSERTs. Listing tables
//                explicitly keeps the exporter away from the virtual table.
//                Read-only on prod; needs the same CLOUDFLARE_* creds as the MCP
//                server (see .env / .env.example), which bun auto-loads.
//   3. locate  — materialise miniflare's local D1 and find its SQLite file under
//                .wrangler/state/v3/d1 (the store the SvelteKit Cloudflare
//                adapter serves during `vite dev`).
//   4. rebuild — replay schema then data into a fresh SQLite via bun:sqlite. We
//                build the file directly with foreign_keys OFF so the dump's
//                forward references (locations -> brands/menus, declared later)
//                replay cleanly.
//
// Local-only side effects: it REPLACES the local D1 file. Prod is never written.
// ---------------------------------------------------------------------------

import { $ } from 'bun';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Matches `database_name` in wrangler.jsonc and the other db:* package scripts.
const DB_NAME = 'better-food-map';
// Where the Cloudflare adapter / miniflare persist the local D1 (v3 layout).
const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

// SQLite/Cloudflare-managed tables we never mirror: SQLite recreates
// sqlite_sequence as needed, and _cf_KV is Cloudflare's internal KV-on-D1 store
// the app doesn't read.
const INTERNAL_TABLES = new Set(['sqlite_sequence', '_cf_KV']);

type SchemaObject = { type: 'table' | 'index' | 'trigger'; name: string; sql: string };

// Run a read-only query on prod and hand back its result rows. `wrangler … --json`
// prints the result as a JSON array on stdout (notices go to stderr); slice to the
// array span so any stray banner line can't trip JSON.parse.
async function queryProd<T>(sql: string): Promise<T[]> {
	const raw = await $`wrangler d1 execute ${DB_NAME} --remote --json --command ${sql}`.text();
	const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
	return (JSON.parse(json) as Array<{ results: T[] }>)[0].results;
}

const dataPath = join(tmpdir(), `${DB_NAME}-prod-data.${process.pid}.sql`);

try {
	// 1. Read prod's schema. `sql IS NOT NULL` skips implicit auto-indexes (those
	//    come back with the table that owns them).
	console.error('→ reading prod schema (sqlite_master)…');
	const schema = await queryProd<SchemaObject>(
		'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name;'
	);

	// An FTS5 virtual table owns hidden shadow tables (`<name>_data`, `_idx`, …)
	// that are created automatically with it — emitting their CREATEs would
	// collide. Identify them by the virtual table's name prefix and drop them.
	const virtualTables = schema
		.filter((o) => /^\s*CREATE VIRTUAL TABLE/i.test(o.sql))
		.map((o) => o.name);
	const isShadowTable = (name: string) => virtualTables.some((v) => name.startsWith(`${v}_`));
	const keepObject = (o: SchemaObject) =>
		!INTERNAL_TABLES.has(o.name) && !(o.type === 'table' && isShadowTable(o.name));

	// Replay order: tables (incl. any virtual table) → indexes → triggers, so each
	// object's dependencies already exist when it's created. Triggers and indexes
	// reference their own table. FKs are off, so ordering among tables is free.
	const rank: Record<SchemaObject['type'], number> = { table: 0, index: 1, trigger: 2 };
	const ddl = schema
		.filter(keepObject)
		.toSorted((a, b) => rank[a.type] - rank[b.type])
		.map((o) => `${o.sql.trim().replace(/;\s*$/, '')};`)
		.join('\n');

	// 2. Export prod row data (read-only). One --table per real table keeps the
	//    exporter away from the virtual table; --no-schema yields INSERTs only.
	const dataTables = schema
		.filter((o) => o.type === 'table' && keepObject(o) && !virtualTables.includes(o.name))
		.map((o) => o.name);
	console.error(`→ exporting prod data (${dataTables.length} tables, read-only)…`);
	const tableArgs = dataTables.flatMap((t) => ['--table', t]);
	await $`wrangler d1 export ${DB_NAME} --remote --no-schema ${tableArgs} --output=${dataPath} -y`.quiet();
	const { size } = await Bun.file(dataPath).stat();
	console.error(`  data: ${(size / 1024 / 1024).toFixed(1)} MB`);

	// 3. Ensure the local D1 file exists, then locate it (the one non-metadata
	//    SQLite in the miniflare dir).
	await $`wrangler d1 execute ${DB_NAME} --local --command ${'SELECT 1;'}`.quiet();
	const dbFile = readdirSync(D1_DIR).find(
		(name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite'
	);
	if (!dbFile) throw new Error(`No local D1 SQLite found in ${D1_DIR}`);
	const dbPath = join(D1_DIR, dbFile);

	// 4. Rebuild the local file from schema + data. Drop WAL/SHM sidecars so we
	//    don't layer a fresh DB under a stale journal.
	for (const suffix of ['', '-wal', '-shm']) {
		const p = dbPath + suffix;
		if (existsSync(p)) rmSync(p);
	}
	const db = new Database(dbPath, { create: true });
	db.exec('PRAGMA foreign_keys=OFF;');
	db.exec(ddl);
	db.exec(await Bun.file(dataPath).text());

	for (const table of ['locations', 'items', 'menus', 'brands', 'tags', 'item_tags']) {
		const { n } = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
		console.error(`  ${table.padEnd(11)} ${n}`);
	}
	db.close();

	console.error(`✓ local D1 mirrored from prod. Restart \`bun run dev\` to pick it up.`);
} finally {
	if (existsSync(dataPath)) rmSync(dataPath);
}
