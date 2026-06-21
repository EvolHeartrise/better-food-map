/// <reference types="bun-types" />
/**
 * One-shot migration of the local SQLite database (`data/food.db`) into the
 * production Cloudflare D1 database, over the D1 REST API.
 *
 * Prerequisites:
 *   1. Create the D1 db:     wrangler d1 create better-food-map
 *      (put the printed database_id in wrangler.jsonc and .env)
 *   2. Apply the schema:     bun run d1:migrate   (wrangler d1 migrations apply … --remote)
 *   3. Set credentials in .env (see .env.example)
 *
 * Then run:  bun run db:seed
 *
 * Rows are inserted in foreign-key-safe order with INSERT OR IGNORE, so the
 * script is safe to re-run against a partially-seeded database (it tops up
 * missing rows and never duplicates). `tags` are seeded by the migration, not
 * here. Intended for an initially-empty D1; it does not overwrite edited rows.
 */
import { Database } from 'bun:sqlite';
import { createHttpD1 } from '../src/lib/server/d1-http';

const SQLITE_PATH = 'data/food.db';

// Tables copied in FK-safe order, with explicit column lists so value order is
// deterministic. `tags` is intentionally omitted (seeded by the migration).
const TABLES: { name: string; columns: string[] }[] = [
	{
		name: 'locations',
		columns: ['id', 'name', 'category', 'latitude', 'longitude', 'address', 'phone', 'website']
	},
	{ name: 'location_sources', columns: ['location_id', 'url', 'label'] },
	{
		name: 'food',
		columns: ['id', 'location_id', 'item_name', 'description', 'ingredients', 'price']
	},
	{ name: 'food_tags', columns: ['food_id', 'tag_id'] },
	{ name: 'food_sources', columns: ['food_id', 'url', 'label'] }
];

// Rows per REST request. Each batch is one atomic multi-statement call; keep it
// modest so request size and statement count stay well within D1's limits.
const CHUNK = 50;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function main() {
	const sqlite = new Database(SQLITE_PATH, { readonly: true });
	const d1 = createHttpD1();

	let grandTotal = 0;
	for (const { name, columns } of TABLES) {
		const colList = columns.join(', ');
		const placeholders = columns.map(() => '?').join(', ');
		const insertSql = `INSERT OR IGNORE INTO ${name} (${colList}) VALUES (${placeholders})`;

		const rows = sqlite.query(`SELECT ${colList} FROM ${name}`).all() as Record<string, unknown>[];

		let written = 0;
		for (const batch of chunk(rows, CHUNK)) {
			const stmts = batch.map((row) => d1.prepare(insertSql).bind(...columns.map((c) => row[c])));
			await d1.batch(stmts);
			written += batch.length;
			process.stderr.write(`  ${name}: ${written}/${rows.length}\r`);
		}
		console.error(`  ${name}: ${rows.length} rows`);
		grandTotal += rows.length;
	}

	sqlite.close();

	// Verify by counting rows on the D1 side.
	console.error('\nVerifying row counts in D1:');
	for (const { name } of TABLES) {
		const res = await d1.prepare(`SELECT COUNT(*) AS c FROM ${name}`).first<{ c: number }>();
		console.error(`  ${name}: ${res?.c ?? '?'}`);
	}

	console.error(`\nDone. Pushed ${grandTotal} rows from ${SQLITE_PATH} to D1.`);
}

main().catch((err) => {
	console.error('Seed failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
