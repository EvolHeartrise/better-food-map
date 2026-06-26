/// <reference types="bun-types" />
/**
 * One-time cleanup: fold prep/form/temperature/freshness-qualified ingredient tags
 * down to their dietary component, seeding the `ingredient_aliases` map so future
 * writes self-correct too (e.g. "grilled chicken" -> "chicken", "steamed milk" ->
 * "milk", "diced tomato" -> "tomato"). The fold/keep/skip decisions were produced
 * by the prep-qualifier-classify workflow (data/fold-classifications.json) and
 * reviewed; only `action: "fold"` entries here, minus one manual override.
 *
 * Each fold's target is resolved TRANSITIVELY through the fold map AND through the
 * live `ingredient_aliases` (so a base that is itself a plural/variant — e.g.
 * "onions" -> "onion" — lands on the true canonical). Then each variant is merged:
 * ensure the canonical tag, repoint its `item_tags` (preserving `optional`), record
 * the alias (source 'prep', keyed by the folded variant), drop the orphan variant
 * tag. Idempotent; backs up before mutating.
 *
 *   bun run scripts/fold-prep-qualifiers.ts            # dry-run (report only)
 *   bun run scripts/fold-prep-qualifiers.ts --apply    # execute against D1
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { foldIngredientName } from '../src/lib/tags';
import type { D1Like } from '../src/lib/server/db';

// Reviewed override: this entry was a fold to a messy compound; treat as skip.
const SKIP_OVERRIDE = new Set(['smoked paprika grilled chicken']);

const ingId = (name: string) => `ing:${name}`;

function mergeStatements(db: D1Like, variant: string, canonical: string) {
	const variantId = ingId(variant);
	const canonicalId = ingId(canonical);
	const foldedVariant = foldIngredientName(variant);
	const stmts = [
		db
			.prepare(`INSERT OR IGNORE INTO tags (id, name, tag_type) VALUES (?, ?, 'ingredient')`)
			.bind(canonicalId, canonical),
		db
			.prepare(
				`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
				 SELECT item_id, ?, optional FROM item_tags WHERE tag_id = ?`
			)
			.bind(canonicalId, variantId),
		db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).bind(variantId)
	];
	if (foldedVariant !== canonical) {
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO ingredient_aliases (alias, canonical_id, source) VALUES (?, ?, 'prep')`
				)
				.bind(foldedVariant, canonicalId)
		);
	}
	stmts.push(db.prepare(`DELETE FROM tags WHERE id = ?`).bind(variantId));
	return stmts;
}

async function main() {
	const apply = process.argv.includes('--apply');
	const db = createHttpD1();

	// The reviewed fold/keep/skip decisions (from the prep-qualifier-classify
	// workflow), committed alongside this script as the audit trail.
	const cls = JSON.parse(readFileSync('scripts/fold-classifications.json', 'utf8'));
	const foldEdges = new Map<string, string>();
	for (const f of cls.folds as { name: string; base: string }[]) {
		if (SKIP_OVERRIDE.has(f.name)) continue;
		const base = f.base.trim();
		if (base && base !== f.name) foldEdges.set(f.name, base);
	}

	// Live state: existing ingredient tags + the Phase-2 alias map (plurals/synonyms).
	const { results: tagRows } = await db
		.prepare(
			`SELECT t.name AS name, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS uses
			 FROM tags t WHERE t.tag_type = 'ingredient'`
		)
		.all<{ name: string; uses: number }>();
	const tagNames = new Set(tagRows.map((t) => t.name));
	const usesByName = new Map(tagRows.map((t) => [t.name, t.uses]));
	const { results: aliasRows } = await db
		.prepare(`SELECT alias, canonical_id FROM ingredient_aliases`)
		.all<{ alias: string; canonical_id: string }>();
	const aliasMap = new Map(aliasRows.map((a) => [a.alias, a.canonical_id.replace(/^ing:/, '')]));

	// Resolve a fold target to its terminal canonical: chase fold edges, then resolve
	// the result (and its folded form) through the live alias map, until stable.
	function resolve(start: string): string {
		let cur = start;
		const seen = new Set<string>([cur]);
		for (let i = 0; i < 20; i++) {
			let next = foldEdges.get(cur) ?? aliasMap.get(cur) ?? aliasMap.get(foldIngredientName(cur));
			if (!next || next === cur || seen.has(next)) break;
			seen.add(next);
			cur = next;
		}
		return cur;
	}

	const merges = [...foldEdges.keys()]
		.filter((v) => tagNames.has(v)) // only variants that still exist as tags
		.map((variant) => ({
			variant,
			canonical: resolve(variant),
			uses: usesByName.get(variant) ?? 0
		}))
		.filter((m) => m.canonical !== m.variant)
		.toSorted((a, b) => b.uses - a.uses);

	const linksMoved = merges.reduce((n, m) => n + m.uses, 0);
	console.error(`Fold merges: ${merges.length}; item links moved: ${linksMoved}`);
	for (const m of merges) console.error(`  ${m.variant} (${m.uses}x)  ->  ${m.canonical}`);
	writeFileSync(
		'data/fold-prep.report.json',
		JSON.stringify({ count: merges.length, linksMoved, merges }, null, 2)
	);

	if (!apply) {
		console.error('\nDRY RUN — pass --apply to execute.');
		return;
	}

	const { results: bTags } = await db
		.prepare(`SELECT id, name FROM tags WHERE tag_type='ingredient'`)
		.all();
	const { results: bLinks } = await db
		.prepare(
			`SELECT item_id, tag_id, optional FROM item_tags WHERE tag_id IN (SELECT id FROM tags WHERE tag_type='ingredient')`
		)
		.all();
	writeFileSync(
		'data/fold-prep.backup.json',
		JSON.stringify({ tags: bTags, item_tags: bLinks }, null, 1)
	);
	console.error(`Backed up ${bTags.length} tags / ${bLinks.length} links.`);

	const CHUNK = 20;
	for (let i = 0; i < merges.length; i += CHUNK) {
		const stmts = merges
			.slice(i, i + CHUNK)
			.flatMap((m) => mergeStatements(db, m.variant, m.canonical));
		await db.batch(stmts);
		console.error(`Applied ${Math.min(i + CHUNK, merges.length)}/${merges.length}…`);
	}
	console.error('Done.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
