/**
 * Bench gold validator.
 *
 * Checks a task's hand-authored gold (gold/data.json) for internal consistency
 * and — critically — against the task's own snapshot: every item name must
 * appear somewhere in the recorded site, and every source URL must actually be
 * recorded. A zero-hit name is either a typo in the gold or a hole in the
 * snapshot; both must be fixed before the gold is trustworthy.
 *
 * Usage:
 *   bun run bench:lint                 # lint every task under bench/tasks/
 *   bun run bench:lint <task-dir>...   # lint specific tasks
 *
 * Errors exit 1 (gold is wrong); warnings print but pass (worth a look).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { isTextType, loadManifest, normalizeUrl, SnapshotStore } from './snapshot-store';

export const DIETARY_TAGS = [
	'vegan',
	'vegetarian',
	'gluten_free',
	'dairy_free',
	'nut_free',
	'halal'
] as const;

// The bench deliberately does NOT score course tags (food/dessert/drink), so
// the gold vocabulary is exactly the six dietary tags.
const TagSchema = v.picklist(DIETARY_TAGS);

export const GoldSchema = v.object({
	policy_version: v.string(),
	sources: v.pipe(v.array(v.pipe(v.string(), v.url())), v.minLength(1)),
	items: v.pipe(
		v.array(
			v.object({
				name: v.pipe(v.string(), v.minLength(1)),
				description: v.nullable(v.pipe(v.string(), v.minLength(1))),
				tags: v.array(TagSchema),
				optional_tags: v.array(TagSchema),
				price: v.nullable(v.pipe(v.number(), v.minValue(0))),
				// A terse authored note flagging an OBVIOUS source contradiction
				// (e.g. a "Vegan" label on an item whose description lists paneer).
				// Presence-only: a non-empty string means "flag it", null/absent
				// means "no warning". Content is authored judgment, not source
				// text, so there is NO snapshot-corpus check for it.
				warning: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))))
			})
		),
		v.minLength(1)
	)
});

export type GoldMenu = v.InferOutput<typeof GoldSchema>;

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' '
};

/**
 * Rendered/raw HTML → searchable text: no scripts/styles/tags, entities decoded.
 * `<img>` alt text survives as `[image: …]` — menu sites routinely carry the only
 * on-page dietary designation ("Vegan Battered Cauliflower …") in a dish photo's
 * alt text, which attribute stripping would otherwise silently drop.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_m, dq, sq) => {
			const alt = (dq ?? sq ?? '').trim();
			return alt ? ` [image: ${alt}] ` : ' ';
		})
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');
}

/** Case- and whitespace-insensitive form used for corpus membership checks. */
export function normalizeForSearch(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A variant item name is `<dish name as displayed> (<variant label>)` — one dish
 * itemized at several prices (sizes/serving formats: "Fresh Soup (Bowl)",
 * "… BC VQA (5 oz)"). Strip ONE trailing parenthetical group and return the base
 * dish name when that leaves something non-empty, else undefined. Only a TRAILING
 * group is stripped, so a mid-string parenthetical ("Aloo kachori (Punjabi Style)
 * 1pc") is untouched, and stripping never applies twice ("X (a) (b)" → "X (a)").
 * The base must still be verbatim in the snapshot; the variant label itself is not
 * corpus-checked (a source may itemize an unlabeled default variant).
 */
export function stripVariantSuffix(name: string): string | undefined {
	const base = name.replace(/\s*\([^()]*\)$/, '');
	return base.length > 0 && base !== name ? base : undefined;
}

export interface LintResult {
	errors: string[];
	warnings: string[];
}

/**
 * Pure gold checks against a pre-built snapshot corpus.
 * `corpus` is normalized snapshot text; `recordedUrls` are normalized recorded GET URLs.
 */
export function lintGold(goldRaw: unknown, corpus: string, recordedUrls: Set<string>): LintResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const parsed = v.safeParse(GoldSchema, goldRaw);
	if (!parsed.success) {
		for (const issue of parsed.issues.slice(0, 10)) {
			errors.push(`schema: ${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`);
		}
		return { errors, warnings };
	}
	const gold = parsed.output;

	const seen = new Set<string>();
	for (const item of gold.items) {
		const label = `item "${item.name}"`;
		const nameKey = normalizeForSearch(item.name);
		if (seen.has(nameKey)) errors.push(`${label}: duplicate item name`);
		seen.add(nameKey);

		const optDup = item.optional_tags.filter((t) => item.tags.includes(t));
		if (optDup.length > 0) {
			errors.push(`${label}: tag(s) in both tags and optional_tags: ${optDup.join(', ')}`);
		}

		const base = stripVariantSuffix(item.name);
		const nameFound =
			corpus.includes(nameKey) || (base !== undefined && corpus.includes(normalizeForSearch(base)));
		if (!nameFound) {
			errors.push(`${label}: name not found anywhere in the snapshot (typo or snapshot hole)`);
		}
		if (item.description !== null && !corpus.includes(normalizeForSearch(item.description))) {
			warnings.push(`${label}: description not found verbatim in the snapshot`);
		}
	}

	for (const src of gold.sources) {
		let norm: string;
		try {
			norm = normalizeUrl(src);
		} catch {
			errors.push(`source ${src}: not a valid URL`);
			continue;
		}
		if (!recordedUrls.has(norm)) {
			errors.push(`source ${src}: not recorded in the snapshot`);
		}
	}

	return { errors, warnings };
}

/** Build the normalized search corpus from every text response + rendered DOM. */
export function buildCorpus(store: SnapshotStore): string {
	const parts: string[] = [];
	for (const entry of store.index.entries) {
		const rendered = store.renderedHtml(entry);
		if (rendered) parts.push(htmlToText(rendered));
		if (entry.file && isTextType(entry.contentType)) {
			const body = store.body(entry);
			if (body) {
				const text = new TextDecoder().decode(body);
				parts.push(entry.contentType?.includes('html') ? htmlToText(text) : text);
			}
		}
	}
	return normalizeForSearch(parts.join(' '));
}

export function lintTask(taskDir: string): LintResult {
	const goldPath = join(taskDir, 'gold', 'data.json');
	if (!existsSync(goldPath)) {
		return { errors: [`no gold/data.json in ${taskDir}`], warnings: [] };
	}
	let goldRaw: unknown;
	try {
		goldRaw = JSON.parse(readFileSync(goldPath, 'utf-8'));
	} catch (e) {
		return { errors: [`gold/data.json is not valid JSON: ${String(e)}`], warnings: [] };
	}
	const manifest = loadManifest(taskDir);
	if (!manifest) {
		return { errors: [`no manifest.json in ${taskDir} — record a snapshot first`], warnings: [] };
	}
	const store = new SnapshotStore(join(taskDir, 'snapshot'));
	const recordedUrls = new Set(
		store.index.entries.filter((e) => e.method === 'GET').map((e) => e.url)
	);
	const result = lintGold(goldRaw, buildCorpus(store), recordedUrls);
	for (const w of manifest.warnings) result.warnings.push(`manifest: ${w}`);
	return result;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const tasksRoot = 'bench/tasks';
	if (args.length === 0 && !existsSync(tasksRoot)) {
		// bench data deliberately lives outside git — on CI there is nothing to lint
		console.error('no bench/tasks directory — nothing to lint (skipping)');
		process.exit(0);
	}
	const taskDirs = args.length > 0 ? args : readdirSync(tasksRoot).map((d) => join(tasksRoot, d));
	if (taskDirs.length === 0) {
		console.error('bench/tasks is empty — nothing to lint (skipping)');
		process.exit(0);
	}
	let failed = false;
	for (const dir of taskDirs) {
		const { errors, warnings } = lintTask(dir);
		const status = errors.length > 0 ? 'FAIL' : 'ok';
		console.error(`${status.padEnd(5)} ${dir}`);
		for (const e of errors) console.error(`  error: ${e}`);
		for (const w of warnings) console.error(`  warning: ${w}`);
		if (errors.length > 0) failed = true;
	}
	process.exit(failed ? 1 : 0);
}
