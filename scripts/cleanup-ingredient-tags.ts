/// <reference types="bun-types" />
/**
 * One-time cleanup of ingredient tags that the prose/qualifier heuristic
 * (`ingredientProseWarning`, src/lib/tags.ts) flags — the long tail the earlier
 * fold/canonicalize passes never covered: un-classified prep/cut/sourcing
 * qualifiers ("whole chicken" -> "chicken"), conjunction fragments ("chopped
 * almonds and pistachios" -> "almonds" + "pistachios") and pure prose that names
 * no ingredient ("steamed then fried", "baked in the tandoor").
 *
 * Three actions, taken from a reviewed decisions file (scripts/ingredient-cleanup-
 * decisions.json), all repointing `item_tags` and dropping the orphan source tag:
 *   • fold   — strip a qualifier to one base noun  ("whole chicken" -> "chicken").
 *   • split  — fan a multi-ingredient tag out to N atomic nouns, preserving the
 *              item's `optional` flag on every new link.
 *   • delete — pure prose / dish name with no usable component: drop tag + links.
 *
 * DELIBERATELY seeds NO `ingredient_aliases` rows (unlike canonicalize-ingredients
 * and fold-prep-qualifiers): many of these names pack two ingredients into one tag,
 * so a single-canonical alias would be wrong, and the project's chosen guard against
 * recurrence is the WRITE-TIME WARNING (ingredientProseWarning), not silent
 * auto-redirect. Descriptions are left untouched (a separate description-correctness
 * sweep owns that). Each split/fold target is resolved through `foldIngredientName`
 * and the live alias map so plurals/variants land on the true canonical.
 *
 *   bun run scripts/cleanup-ingredient-tags.ts --worklist   # dump heuristic-flagged tags
 *   bun run scripts/cleanup-ingredient-tags.ts              # dry-run the decisions (report only)
 *   bun run scripts/cleanup-ingredient-tags.ts --apply      # execute against D1 (backs up first)
 * Reads D1 credentials from .env (same prod database the MCP server writes).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { foldIngredientName, ingredientProseWarning } from '../src/lib/tags';
import type { D1Like, D1PreparedLike } from '../src/lib/server/db';

const DECISIONS_PATH = 'scripts/ingredient-cleanup-decisions.json';
const ingId = (name: string) => `ing:${name}`;

interface FoldDecision {
	name: string;
	base: string;
	reason?: string;
}
interface SplitDecision {
	name: string;
	parts: string[];
	reason?: string;
}
interface DeleteDecision {
	name: string;
	reason?: string;
}
interface Decisions {
	fold: FoldDecision[];
	split: SplitDecision[];
	delete: DeleteDecision[];
	keep?: { name: string; reason?: string }[];
}

/** Repoint every item link from `source` to `target` (preserving optional), then
 *  drop the source links. The source tag row itself is dropped once, by the caller. */
function repointStmts(db: D1Like, sourceId: string, targetName: string): D1PreparedLike[] {
	const targetId = ingId(targetName);
	return [
		db
			.prepare(`INSERT OR IGNORE INTO tags (id, name, tag_type) VALUES (?, ?, 'ingredient')`)
			.bind(targetId, targetName),
		db
			.prepare(
				`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
				 SELECT item_id, ?, optional FROM item_tags WHERE tag_id = ?`
			)
			.bind(targetId, sourceId)
	];
}

async function main() {
	const worklistOnly = process.argv.includes('--worklist');
	const apply = process.argv.includes('--apply');
	const db = createHttpD1();

	const { results: tagRows } = await db
		.prepare(
			`SELECT t.name AS name, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS uses
			 FROM tags t WHERE t.tag_type = 'ingredient'`
		)
		.all<{ name: string; uses: number }>();
	const tagNames = new Set(tagRows.map((t) => t.name));

	// Worklist: exactly what the heuristic flags now, newest-trouble (most-used) first.
	const flagged = tagRows
		.map((t) => ({ name: t.name, uses: t.uses, reason: ingredientProseWarning(t.name) }))
		.filter((t): t is { name: string; uses: number; reason: string } => t.reason !== null)
		.toSorted((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

	if (worklistOnly) {
		writeFileSync(
			'data/ingredient-cleanup.worklist.json',
			JSON.stringify({ count: flagged.length, flagged }, null, 2)
		);
		console.error(`Heuristic-flagged ingredient tags: ${flagged.length}`);
		for (const f of flagged) console.error(`  ${f.name} (${f.uses}x) — ${f.reason}`);
		console.error('\nWorklist written to data/ingredient-cleanup.worklist.json');
		return;
	}

	// Resolve each fold/split target through the alias map so plurals/variants land on
	// the canonical (e.g. "almonds" -> "almond", "onions" -> "onion").
	const { results: aliasRows } = await db
		.prepare(`SELECT alias, canonical_id FROM ingredient_aliases`)
		.all<{ alias: string; canonical_id: string }>();
	const aliasMap = new Map(aliasRows.map((a) => [a.alias, a.canonical_id.replace(/^ing:/, '')]));
	function resolve(raw: string): string {
		let cur = foldIngredientName(raw);
		const seen = new Set<string>([cur]);
		for (let i = 0; i < 20; i++) {
			const next = aliasMap.get(cur) ?? aliasMap.get(foldIngredientName(cur));
			if (!next || next === cur || seen.has(next)) break;
			seen.add(next);
			cur = next;
		}
		return cur;
	}

	const cls = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')) as Decisions;
	const decided = new Set<string>([
		...cls.fold.map((d) => d.name),
		...cls.split.map((d) => d.name),
		...cls.delete.map((d) => d.name),
		...(cls.keep ?? []).map((d) => d.name)
	]);

	// Cross-checks so the dry-run report surfaces gaps before anything is applied.
	const warnings: string[] = [];
	for (const f of flagged)
		if (!decided.has(f.name)) warnings.push(`UNCLASSIFIED flagged tag: "${f.name}" (${f.uses}x)`);
	for (const d of decided)
		if (!tagNames.has(d)) warnings.push(`decision for missing tag (already gone?): "${d}"`);
	const targetsOf = (d: FoldDecision | SplitDecision) => ('base' in d ? [d.base] : d.parts);
	for (const d of [...cls.fold, ...cls.split])
		for (const t of targetsOf(d)) {
			const r = ingredientProseWarning(resolve(t));
			if (r) warnings.push(`target "${t}" of "${d.name}" still reads like prose: ${r}`);
		}

	// Build the plan.
	type Op = { name: string; action: 'fold' | 'split' | 'delete'; targets: string[]; uses: number };
	const usesByName = new Map(tagRows.map((t) => [t.name, t.uses]));
	const ops: Op[] = [];
	for (const d of cls.fold)
		if (tagNames.has(d.name) && resolve(d.base) !== d.name)
			ops.push({
				name: d.name,
				action: 'fold',
				targets: [resolve(d.base)],
				uses: usesByName.get(d.name) ?? 0
			});
	for (const d of cls.split)
		if (tagNames.has(d.name))
			ops.push({
				name: d.name,
				action: 'split',
				targets: [...new Set(d.parts.map(resolve))].filter((t) => t !== d.name),
				uses: usesByName.get(d.name) ?? 0
			});
	for (const d of cls.delete)
		if (tagNames.has(d.name))
			ops.push({ name: d.name, action: 'delete', targets: [], uses: usesByName.get(d.name) ?? 0 });

	const linksMoved = ops.filter((o) => o.action !== 'delete').reduce((n, o) => n + o.uses, 0);
	const linksDropped = ops.filter((o) => o.action === 'delete').reduce((n, o) => n + o.uses, 0);
	console.error(
		`Decisions: fold ${cls.fold.length}, split ${cls.split.length}, delete ${cls.delete.length}, keep ${(cls.keep ?? []).length}`
	);
	console.error(
		`Actionable ops: ${ops.length} (tags removed); item links repointed ${linksMoved}, dropped ${linksDropped}`
	);
	for (const o of ops)
		console.error(
			`  [${o.action}] ${o.name} (${o.uses}x)` +
				(o.targets.length ? `  ->  ${o.targets.join(', ')}` : '  ->  (removed)')
		);
	if (warnings.length) {
		console.error(`\n${warnings.length} WARNING(S):`);
		for (const w of warnings) console.error(`  ! ${w}`);
	}
	writeFileSync(
		'data/ingredient-cleanup.report.json',
		JSON.stringify({ ops, linksMoved, linksDropped, warnings }, null, 2)
	);
	console.error('\nReport written to data/ingredient-cleanup.report.json');

	if (!apply) {
		console.error('\nDRY RUN — pass --apply to execute against D1.');
		return;
	}

	// Back up the ingredient vocabulary + its links before mutating, for reversibility.
	const { results: bTags } = await db
		.prepare(`SELECT id, name FROM tags WHERE tag_type='ingredient'`)
		.all();
	const { results: bLinks } = await db
		.prepare(
			`SELECT item_id, tag_id, optional FROM item_tags WHERE tag_id IN (SELECT id FROM tags WHERE tag_type='ingredient')`
		)
		.all();
	writeFileSync(
		'data/ingredient-cleanup.backup.json',
		JSON.stringify({ tags: bTags, item_tags: bLinks }, null, 1)
	);
	console.error(`Backed up ${bTags.length} tags / ${bLinks.length} links.`);

	const CHUNK = 20;
	for (let i = 0; i < ops.length; i += CHUNK) {
		const stmts = ops.slice(i, i + CHUNK).flatMap((o) => {
			const sourceId = ingId(o.name);
			const s = o.targets.flatMap((t) => repointStmts(db, sourceId, t));
			s.push(db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).bind(sourceId));
			s.push(db.prepare(`DELETE FROM tags WHERE id = ?`).bind(sourceId));
			return s;
		});
		await db.batch(stmts);
		console.error(`Applied ${Math.min(i + CHUNK, ops.length)}/${ops.length}…`);
	}
	console.error('Done.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
