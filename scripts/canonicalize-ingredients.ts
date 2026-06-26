/// <reference types="bun-types" />
/**
 * One-time vocabulary cleanup: collapse fragmented ingredient tags into one
 * canonical tag each, seeding the `ingredient_aliases` map (migration 0010) so the
 * write path and the tag-filter search both resolve variants to the canonical.
 *
 * Three edge sources, all merging a VARIANT tag into a CANONICAL one:
 *   1. diacritics — an accented name folds to its ASCII form (foldIngredientName);
 *      handled deterministically (prose-looking accented names are skipped — those
 *      are Phase 3 work, scripts/extract-prose-ingredients.ts).
 *   2. plurals    — when BOTH a singular X and its plural (X+s / X+es / y→ies)
 *      exist as tags, the plural merges into the singular. The both-exist guard is
 *      what makes this safe: we never invent a singular (no "molasses"→"molasse").
 *   3. synonyms   — a small hand-reviewed map of spelling variants / equivalents.
 *
 * Edges are resolved TRANSITIVELY to a terminal canonical (so "jalapeños" →
 * "jalapenos" → "jalapeno" lands on "jalapeno"), then each variant is merged:
 * ensure the canonical tag exists, repoint its `item_tags` to the canonical
 * (preserving the `optional` flag, ignoring collisions), register the alias (keyed
 * by the FOLDED variant, only when it differs from the canonical — a pure-diacritic
 * variant needs no row because the write path already folds), and drop the orphan
 * variant tag. Idempotent: a re-run finds the variants already gone and no-ops.
 *
 * Usage:
 *   bun run scripts/canonicalize-ingredients.ts            # dry-run: report only
 *   bun run scripts/canonicalize-ingredients.ts --apply    # execute against D1
 * Reads D1 credentials from .env (same prod database the MCP server writes).
 */

import { writeFileSync } from 'node:fs';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { foldIngredientName, ingredientProseWarning } from '../src/lib/tags';
import type { D1Like } from '../src/lib/server/db';

/**
 * Hand-reviewed synonym / spelling-variant map (variant → canonical). Kept small
 * and uncontroversial; British/American spellings and a few well-known equivalents.
 * Plurals and diacritics are derived automatically and need no entries here.
 */
export const SYNONYMS: Record<string, string> = {
	chilli: 'chili',
	chillies: 'chili',
	chillie: 'chili',
	yoghurt: 'yogurt',
	doughnut: 'donut',
	doughnuts: 'donut',
	garbanzo: 'chickpea',
	'garbanzo bean': 'chickpea',
	'garbanzo beans': 'chickpea',
	'french fries': 'fries',
	aubergine: 'eggplant',
	courgette: 'zucchini',
	capsicum: 'bell pepper',
	scallion: 'green onion',
	scallions: 'green onion',
	'spring onion': 'green onion',
	'spring onions': 'green onion'
};

/** Candidate plural surface forms of a singular base name. */
function pluralsOf(base: string): string[] {
	const forms = [base + 's', base + 'es'];
	if (base.endsWith('y')) forms.push(base.slice(0, -1) + 'ies');
	return forms;
}

/**
 * Builds the raw variant → canonical edge map from the current ingredient-tag
 * name set. Pure (no DB), so it is unit-tested directly.
 */
export function deriveEdges(names: string[]): Map<string, string> {
	const present = new Set(names);
	const edges = new Map<string, string>();
	const add = (variant: string, canonical: string) => {
		if (variant !== canonical && !edges.has(variant)) edges.set(variant, canonical);
	};

	// 1. diacritics: accented name → folded ASCII form (skip prose-looking names).
	for (const name of names) {
		const folded = foldIngredientName(name);
		if (folded !== name && !ingredientProseWarning(name)) add(name, folded);
	}
	// 2. plurals: plural → singular, only when both already exist as tags.
	for (const name of names) {
		if (name.length < 3) continue;
		for (const plural of pluralsOf(name)) if (present.has(plural)) add(plural, name);
	}
	// 3. synonyms: only when the canonical is a real (or derivable) target.
	for (const [variant, canonical] of Object.entries(SYNONYMS)) {
		if (present.has(variant)) add(variant, canonical);
	}
	return edges;
}

/**
 * Follows each variant's edges to its terminal canonical (a name with no outgoing
 * edge), collapsing chains. Self-references and cycles are dropped defensively.
 * Returns variant → terminalCanonical for variants that actually move.
 */
export function resolveCanonical(edges: Map<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const start of edges.keys()) {
		let cur = start;
		const seen = new Set<string>([cur]);
		for (let next = edges.get(cur); next !== undefined; next = edges.get(cur)) {
			if (seen.has(next)) {
				cur = start; // cycle — leave this variant unmerged
				break;
			}
			seen.add(next);
			cur = next;
		}
		if (cur !== start) out.set(start, cur);
	}
	return out;
}

const ingId = (name: string) => `ing:${name}`;

/** The statements that merge one variant tag into its canonical, in batch order. */
function mergeStatements(db: D1Like, variant: string, canonical: string) {
	const variantId = ingId(variant);
	const canonicalId = ingId(canonical);
	const foldedVariant = foldIngredientName(variant);
	const stmts = [
		// Ensure the canonical tag exists (it may be a brand-new folded form).
		db
			.prepare(`INSERT OR IGNORE INTO tags (id, name, tag_type) VALUES (?, ?, 'ingredient')`)
			.bind(canonicalId, canonical),
		// Repoint links, preserving `optional`; PK (item_id, tag_id) drops collisions.
		db
			.prepare(
				`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
				 SELECT item_id, ?, optional FROM item_tags WHERE tag_id = ?`
			)
			.bind(canonicalId, variantId),
		db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).bind(variantId)
	];
	// Register the alias for the write/read paths — but only when the folded variant
	// differs from the canonical. A pure-diacritic variant folds straight to the
	// canonical, so the write path never looks it up and no row is needed.
	if (foldedVariant !== canonical) {
		const source = SYNONYMS[variant]
			? 'synonym'
			: foldedVariant === variant
				? 'plural'
				: 'diacritic';
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO ingredient_aliases (alias, canonical_id, source) VALUES (?, ?, ?)`
				)
				.bind(foldedVariant, canonicalId, source)
		);
	}
	// Drop the now-orphan variant tag (cascades to tags_fts via the 0006 trigger).
	stmts.push(db.prepare(`DELETE FROM tags WHERE id = ?`).bind(variantId));
	return stmts;
}

async function main() {
	const apply = process.argv.includes('--apply');
	const db = createHttpD1();

	const { results: tags } = await db
		.prepare(
			`SELECT t.name AS name,
				(SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS uses
			 FROM tags t WHERE t.tag_type = 'ingredient'`
		)
		.all<{ name: string; uses: number }>();
	const usesByName = new Map(tags.map((t) => [t.name, t.uses]));

	const edges = deriveEdges(tags.map((t) => t.name));
	const resolved = resolveCanonical(edges);

	const merges = [...resolved.entries()]
		.map(([variant, canonical]) => ({
			variant,
			canonical,
			variant_uses: usesByName.get(variant) ?? 0,
			source: SYNONYMS[variant]
				? 'synonym'
				: foldIngredientName(variant) === variant
					? 'plural'
					: 'diacritic'
		}))
		.toSorted((a, b) => b.variant_uses - a.variant_uses);

	const linksMoved = merges.reduce((n, m) => n + m.variant_uses, 0);
	const bySource = merges.reduce<Record<string, number>>((acc, m) => {
		acc[m.source] = (acc[m.source] ?? 0) + 1;
		return acc;
	}, {});

	console.error(`Ingredient tags: ${tags.length}`);
	console.error(
		`Merges: ${merges.length} (${JSON.stringify(bySource)}); item links moved: ${linksMoved}`
	);
	for (const m of merges) {
		console.error(`  [${m.source}] ${m.variant} (${m.variant_uses}x)  ->  ${m.canonical}`);
	}

	const reportPath = 'data/canonicalize-ingredients.report.json';
	writeFileSync(
		reportPath,
		JSON.stringify({ count: merges.length, linksMoved, bySource, merges }, null, 2)
	);
	console.error(`\nReport written to ${reportPath}`);

	if (!apply) {
		console.error('\nDRY RUN — pass --apply to execute the merges against D1.');
		return;
	}

	// Back up the ingredient vocabulary + its links before mutating, for reversibility.
	const { results: backupTags } = await db
		.prepare(`SELECT id, name FROM tags WHERE tag_type = 'ingredient'`)
		.all();
	const { results: backupLinks } = await db
		.prepare(
			`SELECT item_id, tag_id, optional FROM item_tags
			 WHERE tag_id IN (SELECT id FROM tags WHERE tag_type = 'ingredient')`
		)
		.all();
	const backupPath = 'data/canonicalize-ingredients.backup.json';
	writeFileSync(backupPath, JSON.stringify({ tags: backupTags, item_tags: backupLinks }, null, 2));
	console.error(
		`Backup of ${backupTags.length} tags / ${backupLinks.length} links written to ${backupPath}`
	);

	// Apply in chunks; each merge's statements run together.
	const CHUNK = 20;
	let done = 0;
	for (let i = 0; i < merges.length; i += CHUNK) {
		const stmts = merges
			.slice(i, i + CHUNK)
			.flatMap((m) => mergeStatements(db, m.variant, m.canonical));
		await db.batch(stmts);
		done += Math.min(CHUNK, merges.length - i);
		console.error(`Applied ${done}/${merges.length} merges…`);
	}
	console.error('Done.');
}

// Only run when executed directly (`bun run …`), never when imported by a test —
// importing must not open a prod D1 connection or mutate anything.
if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
