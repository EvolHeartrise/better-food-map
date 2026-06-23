/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// Mirrors the production Cloudflare D1 database into the local one that
// `vite dev` reads, so local development shows real venues/menus.
//
//   bun run db:pull
//
// Pipeline:
//   1. export  — `wrangler d1 export --remote` dumps prod (schema + data) to a
//                temp .sql file. Read-only on prod; needs the same
//                CLOUDFLARE_* creds as the MCP server (see .env / .env.example),
//                which bun auto-loads from .env.
//   2. locate  — materialise miniflare's local D1 and find its SQLite file under
//                .wrangler/state/v3/d1 (the store the SvelteKit Cloudflare
//                adapter serves during `vite dev`).
//   3. rebuild — replay the dump into a fresh SQLite via bun:sqlite. We build the
//                file directly (foreign_keys default OFF) so the dump's forward
//                references (locations -> brands/menus, declared later in the
//                file) replay cleanly — miniflare's own importer enforces FKs in
//                autocommit and chokes on them.
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

const dumpPath = join(tmpdir(), `${DB_NAME}-prod-dump.${process.pid}.sql`);

try {
	// 1. Export prod (read-only). Creds come from the environment (.env).
	console.error('→ exporting prod D1 (this reads prod, never writes it)…');
	await $`wrangler d1 export ${DB_NAME} --remote --output=${dumpPath}`.quiet();
	const { size } = await Bun.file(dumpPath).stat();
	console.error(`  dump: ${(size / 1024 / 1024).toFixed(1)} MB`);

	// 2. Ensure the local D1 file exists, then locate it (the one non-metadata
	//    SQLite in the miniflare dir).
	await $`wrangler d1 execute ${DB_NAME} --local --command ${'SELECT 1;'}`.quiet();
	const dbFile = readdirSync(D1_DIR).find(
		(name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite'
	);
	if (!dbFile) throw new Error(`No local D1 SQLite found in ${D1_DIR}`);
	const dbPath = join(D1_DIR, dbFile);

	// 3. Rebuild the local file from the dump. Drop WAL/SHM sidecars so we don't
	//    layer a fresh DB under a stale journal.
	for (const suffix of ['', '-wal', '-shm']) {
		const p = dbPath + suffix;
		if (existsSync(p)) rmSync(p);
	}
	const db = new Database(dbPath, { create: true });
	db.exec('PRAGMA foreign_keys=OFF;');
	db.exec(await Bun.file(dumpPath).text());

	for (const table of ['locations', 'food', 'menus', 'menu_items', 'brands', 'tags']) {
		const { n } = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
		console.error(`  ${table.padEnd(11)} ${n}`);
	}
	db.close();

	console.error(`✓ local D1 mirrored from prod. Restart \`bun run dev\` to pick it up.`);
} finally {
	if (existsSync(dumpPath)) rmSync(dumpPath);
}
