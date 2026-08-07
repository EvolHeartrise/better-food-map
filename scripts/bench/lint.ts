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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Named HTML entities `htmlToText` decodes.
 *
 * Deliberately a focused set rather than the full HTML5 table: menu pages use a
 * narrow vocabulary — structural characters, typographic punctuation, legal
 * marks, and the accented letters of café/jalapeño/crème. Everything else is
 * covered by the numeric forms, and an entity this table does not know is left
 * INTACT rather than destroyed (see `decodeEntity`).
 */
const ENTITIES: Record<string, string> = {
	// structural
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
	'&nbsp;': ' ',
	// typographic punctuation
	'&rsquo;': '’',
	'&lsquo;': '‘',
	'&rdquo;': '”',
	'&ldquo;': '“',
	'&ndash;': '–',
	'&mdash;': '—',
	'&hellip;': '…',
	'&middot;': '·',
	'&bull;': '•',
	'&laquo;': '«',
	'&raquo;': '»',
	'&deg;': '°',
	// legal / commercial marks
	'&reg;': '®',
	'&copy;': '©',
	'&trade;': '™',
	// accented letters, both cases
	'&eacute;': 'é',
	'&Eacute;': 'É',
	'&egrave;': 'è',
	'&Egrave;': 'È',
	'&agrave;': 'à',
	'&Agrave;': 'À',
	'&ccedil;': 'ç',
	'&Ccedil;': 'Ç',
	'&ntilde;': 'ñ',
	'&Ntilde;': 'Ñ',
	'&uuml;': 'ü',
	'&Uuml;': 'Ü',
	'&ouml;': 'ö',
	'&Ouml;': 'Ö',
	'&auml;': 'ä',
	'&Auml;': 'Ä'
};

const ENTITY_RE = /&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#[xX][0-9a-fA-F]+;/g;

/**
 * One HTML entity → the character it denotes, or the entity UNCHANGED when it
 * cannot be decoded.
 *
 * Leaving an unknown entity intact is the point. The previous implementation
 * replaced every entity outside a seven-item table with a SPACE, which silently
 * destroyed characters — `caf&eacute;` became `caf` (losing both the é and the
 * word boundary), `Flamin&#8217;` became `Flamin`, and `NYF&reg;` became `NYF `.
 * Across the current snapshots that was ~600 destroyed characters, each one a
 * potential false "not found in the snapshot" for a gold name or description.
 * It also reached MODELS, since `fetchPage` renders pages through this same
 * function. A literal `&hearts;` surviving in the text is noise; a deleted
 * apostrophe is a wrong answer, so unknown decodes to itself.
 *
 * Named lookup is exact first, then lowercased, so `&AMP;` still decodes while
 * `&Eacute;` keeps its case.
 */
function decodeEntity(entity: string): string {
	const named = ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()];
	if (named !== undefined) return named;

	const decimal = /^&#(\d+);$/.exec(entity);
	const hex = decimal ? null : /^&#[xX]([0-9a-fA-F]+);$/.exec(entity);
	if (!decimal && !hex) return entity;
	const code = decimal
		? Number.parseInt(decimal[1], 10)
		: Number.parseInt((hex as RegExpExecArray)[1], 16);

	// NUL, lone surrogates and out-of-range values are not text; keep the source
	// bytes visible rather than injecting something unrepresentable.
	if (
		!Number.isInteger(code) ||
		code <= 0 ||
		code > 0x10ffff ||
		(code >= 0xd800 && code <= 0xdfff)
	) {
		return entity;
	}
	return String.fromCodePoint(code);
}

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
		.replace(ENTITY_RE, decodeEntity);
}

/**
 * Case-, whitespace- and apostrophe-insensitive form used for corpus membership
 * checks and for the scorer's name/description matching.
 *
 * Unicode is normalized to NFC FIRST, because a composed character and its
 * decomposed form render identically but never compare equal: MeeT's snapshot
 * spells "sautéed" as `e`+U+0301 (NFD) while the hand-authored gold carries
 * U+00E9 (NFC), so the description check reported a mismatch between two strings
 * a human cannot tell apart. Normalizing is not a fuzzy match — it is the
 * standard equality for text that Unicode itself defines as equivalent.
 *
 * The apostrophe family (’ ‘ ʼ ´ `) then folds to a plain ASCII ' so a name like
 * "Mac n’ Cheez" matches "Mac n' Cheez" — a model straightening the source's
 * curly apostrophe (a detokenizer habit it can't reliably control) is typography,
 * not an extraction error, so it must never split a match. Apostrophe style is
 * never semantic, so folding it can only merge two spellings of the SAME name,
 * never distinct items.
 */
export function normalizeForSearch(text: string): string {
	return text
		.normalize('NFC')
		.replace(/[’‘ʼ´`]/g, "'")
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
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
	/**
	 * Set by `lintTask` only, when the directory holds nothing to lint YET — a
	 * task scaffolded by `bench:new`, or recorded and drafted but not promoted.
	 * Holds the human reason. `lintGold` never sets it: given gold, there is
	 * always something to check.
	 */
	skipped?: string;
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

		// Try the full name, then progressively strip trailing "(…)" groups: a name
		// like "Stone Road … (5 oz glass) (Happy Hour)" carries TWO trailing groups
		// (a size AND a Happy-Hour/daily-special context), so one strip is not enough
		// — keep stripping until the base is in the corpus or nothing parenthetical
		// remains. stripVariantSuffix returns undefined at the end (no trailing group
		// or an empty base), which terminates the loop.
		let nameFound = corpus.includes(nameKey);
		for (
			let base = stripVariantSuffix(item.name);
			!nameFound && base !== undefined;
			base = stripVariantSuffix(base)
		) {
			if (corpus.includes(normalizeForSearch(base))) nameFound = true;
		}
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

/**
 * Lint one task directory.
 *
 * A dir with no `gold/data.json` is SKIPPED, not failed. When this linter was
 * written a task directory meant an authored task, so absent gold could only be
 * a mistake. `bench:new` (scaffolds a task dir before anything is recorded) and
 * `bench:draft` (writes `gold/draft.json`, deliberately never `data.json`) both
 * landed the following day and made "recorded, drafted, not yet promoted" a
 * normal, long-lived state — one the authoring workflow in the README walks
 * through on purpose. Reporting it as an error made `bench:lint` permanently red
 * for doing exactly what the docs say, which is how a linter stops being read.
 *
 * The CLI still fails on a skip for a task named EXPLICITLY on the command line:
 * asking to lint one task by name and getting silence is its own trap.
 */
export function lintTask(taskDir: string): LintResult {
	const goldPath = join(taskDir, 'gold', 'data.json');
	if (!existsSync(goldPath)) {
		const drafted = existsSync(join(taskDir, 'gold', 'draft.json'));
		return {
			errors: [],
			warnings: [],
			skipped: drafted
				? 'gold/draft.json exists but has not been promoted to gold/data.json'
				: 'no gold authored yet'
		};
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
	// The manifest's own warnings ("page budget exhausted with 154 URLs
	// unvisited") are NOT re-reported here. They describe the SNAPSHOT, not the
	// gold, they are identical on every run until the venue is re-recorded, and
	// they belong to the tools that own that state — the recorder prints them and
	// `bench:new --status` tracks it. Repeating them under every lint trained the
	// eye to skim past the section where real findings appear.
	return lintGold(goldRaw, buildCorpus(store), recordedUrls);
}

/** True when the path exists and is a directory; false on anything unreadable. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const tasksRoot = 'bench/tasks';
	if (args.length === 0 && !existsSync(tasksRoot)) {
		// bench data deliberately lives outside git — on CI there is nothing to lint
		console.error('no bench/tasks directory — nothing to lint (skipping)');
		process.exit(0);
	}
	// Explicitly named dirs are linted as given; a bare scan takes only
	// directories, so a stray file under bench/tasks (a .DS_Store, a notes.md)
	// cannot fail the run with a confusing "no manifest.json" for a non-task.
	const explicit = args.length > 0;
	const taskDirs = explicit
		? args
		: readdirSync(tasksRoot)
				.map((d) => join(tasksRoot, d))
				.filter(isDirectory);
	if (taskDirs.length === 0) {
		console.error('bench/tasks is empty — nothing to lint (skipping)');
		process.exit(0);
	}
	let failed = false;
	for (const dir of taskDirs) {
		const { errors, warnings, skipped } = lintTask(dir);
		// A skip is a finding only when this task was asked for by name.
		if (skipped !== undefined && !explicit) {
			console.error(`skip  ${dir}`);
			console.error(`  ${skipped}`);
			continue;
		}
		const allErrors = skipped !== undefined ? [...errors, skipped] : errors;
		const status = allErrors.length > 0 ? 'FAIL' : 'ok';
		console.error(`${status.padEnd(5)} ${dir}`);
		for (const e of allErrors) console.error(`  error: ${e}`);
		for (const w of warnings) console.error(`  warning: ${w}`);
		if (allErrors.length > 0) failed = true;
	}
	process.exit(failed ? 1 : 0);
}
