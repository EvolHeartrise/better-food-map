/// <reference types="bun-types" />
/**
 * One-time cleanup of PROSE that was authored into `ingredients` — full dish
 * descriptions, prices and serving notes that became giant "ingredient" tags
 * (e.g. "served with sambar and coconut chutney", "12 oz ... choice of milk").
 *
 * This is agent-assisted, in two passes:
 *
 *   1. WORKLIST (default) — read-only. Scans ingredient tags with
 *      `ingredientProseWarning`, finds every item linked to one, and emits a
 *      worklist (data/prose-ingredients.worklist.json): per item its name, current
 *      `description`, and its ingredient parts split into CLEAN (keep) vs PROSE
 *      (re-extract). An agent then proposes, per item, a clean `{ description,
 *      ingredients }` — moving the prose text into `description` and listing only
 *      the real component nouns — and writes a decisions file.
 *
 *   2. APPLY (`--apply <decisions.json>`) — for each decision, updateItem replaces
 *      the item's description + ingredient set (dropping the prose tag links), then
 *      any prose ingredient tag left with zero links is deleted as an orphan.
 *
 * Decisions file shape: { decisions: Array<{ item_id: string; description?: string |
 * null; ingredients: string; optional_ingredients?: string | null }> }.
 *
 * Usage:
 *   bun run scripts/extract-prose-ingredients.ts                       # worklist
 *   bun run scripts/extract-prose-ingredients.ts --apply decisions.json
 * Reads D1 credentials from .env (same prod database the MCP server writes).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { updateItem, type D1Like } from '../src/lib/server/db';
import { ingredientProseWarning } from '../src/lib/tags';

interface WorklistItem {
	item_id: string;
	item_name: string;
	description: string | null;
	clean_ingredients: string[];
	prose_ingredients: { name: string; optional: boolean; reason: string }[];
}

/** Ingredient tags whose NAME reads like prose, with the items that use each. */
async function proseTags(db: D1Like) {
	const { results } = await db
		.prepare(
			`SELECT t.id AS id, t.name AS name FROM tags t WHERE t.tag_type = 'ingredient' ORDER BY LENGTH(t.name) DESC`
		)
		.all<{ id: string; name: string }>();
	return results
		.map((t) => ({ ...t, reason: ingredientProseWarning(t.name) }))
		.filter((t): t is { id: string; name: string; reason: string } => t.reason !== null);
}

async function buildWorklist(
	db: D1Like
): Promise<{ items: WorklistItem[]; proseTagIds: string[] }> {
	const prose = await proseTags(db);
	const proseIds = new Set(prose.map((t) => t.id));

	// Every item linked to a prose tag, with ALL of its ingredient tags so the agent
	// sees the full picture (clean parts to keep + prose parts to re-extract).
	const { results: rows } = await db
		.prepare(
			`SELECT i.id AS item_id, i.item_name AS item_name, i.description AS description,
				t.id AS tag_id, t.name AS tag_name, it.optional AS optional
			 FROM items i
			 JOIN item_tags it ON it.item_id = i.id
			 JOIN tags t ON t.id = it.tag_id
			 WHERE t.tag_type = 'ingredient'
				AND i.id IN (
					SELECT item_id FROM item_tags WHERE tag_id IN
					(SELECT id FROM tags WHERE tag_type='ingredient')
				)
			 ORDER BY i.id`
		)
		.all<{
			item_id: string;
			item_name: string;
			description: string | null;
			tag_id: string;
			tag_name: string;
			optional: number;
		}>();

	const byItem = new Map<string, WorklistItem>();
	for (const r of rows) {
		let wi = byItem.get(r.item_id);
		if (!wi) {
			wi = {
				item_id: r.item_id,
				item_name: r.item_name,
				description: r.description,
				clean_ingredients: [],
				prose_ingredients: []
			};
			byItem.set(r.item_id, wi);
		}
		if (proseIds.has(r.tag_id)) {
			wi.prose_ingredients.push({
				name: r.tag_name,
				optional: r.optional !== 0,
				reason: ingredientProseWarning(r.tag_name) ?? ''
			});
		} else {
			wi.clean_ingredients.push(r.tag_name);
		}
	}
	// Only items that actually carry a prose tag need re-extraction.
	const items = [...byItem.values()].filter((wi) => wi.prose_ingredients.length > 0);
	return { items, proseTagIds: [...proseIds] };
}

interface Decision {
	item_id: string;
	description?: string | null;
	ingredients: string;
	optional_ingredients?: string | null;
}

async function apply(db: D1Like, decisionsPath: string) {
	const parsed = JSON.parse(readFileSync(decisionsPath, 'utf8')) as { decisions: Decision[] };
	const decisions = parsed.decisions ?? [];
	console.error(`Applying ${decisions.length} item re-extractions…`);

	let updated = 0;
	const stillProse: string[] = [];
	for (const d of decisions) {
		// Surface a quality warning if the proposed ingredients STILL read like prose.
		for (const part of d.ingredients.split(',')) {
			const reason = ingredientProseWarning(part);
			if (reason) stillProse.push(`${d.item_id} "${part.trim()}" ${reason}`);
		}
		const res = await updateItem(db, d.item_id, {
			description: d.description ?? null,
			ingredients: d.ingredients,
			optionalIngredients: d.optional_ingredients ?? null
		});
		if (res) updated++;
		else console.error(`  ! no item ${d.item_id}`);
	}
	console.error(`Updated ${updated}/${decisions.length} items.`);
	if (stillProse.length) {
		console.error(
			`\nWARNING: ${stillProse.length} proposed ingredient parts still look like prose:`
		);
		for (const s of stillProse) console.error(`  ${s}`);
	}

	// Delete prose ingredient tags now orphaned (zero links) by the re-extraction.
	const { results: orphans } = await db
		.prepare(
			`SELECT t.id, t.name FROM tags t
			 WHERE t.tag_type = 'ingredient'
				AND NOT EXISTS (SELECT 1 FROM item_tags it WHERE it.tag_id = t.id)`
		)
		.all<{ id: string; name: string }>();
	const orphanProse = orphans.filter((t) => ingredientProseWarning(t.name) !== null);
	if (orphanProse.length) {
		await db.batch(orphanProse.map((t) => db.prepare(`DELETE FROM tags WHERE id = ?`).bind(t.id)));
		console.error(`Deleted ${orphanProse.length} now-orphan prose ingredient tags.`);
	}
}

async function main() {
	const db = createHttpD1();
	const applyIdx = process.argv.indexOf('--apply');
	if (applyIdx !== -1) {
		const path = process.argv[applyIdx + 1];
		if (!path) throw new Error('--apply requires a decisions JSON path.');
		await apply(db, path);
		return;
	}

	const { items, proseTagIds } = await buildWorklist(db);
	const totalProseParts = items.reduce((n, i) => n + i.prose_ingredients.length, 0);
	const emptyDesc = items.filter((i) => !i.description || i.description.trim() === '').length;
	console.error(`Prose ingredient tags: ${proseTagIds.length}`);
	console.error(
		`Items needing re-extraction: ${items.length} (${emptyDesc} with empty description)`
	);
	console.error(`Prose ingredient parts to move: ${totalProseParts}`);

	const path = 'data/prose-ingredients.worklist.json';
	writeFileSync(path, JSON.stringify({ count: items.length, items }, null, 2));
	console.error(
		`\nWorklist written to ${path} — re-extract per item, then --apply <decisions.json>.`
	);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

export { buildWorklist, proseTags };
