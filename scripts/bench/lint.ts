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
 * marks, accented letters, and the invisible spacing family. Everything else is
 * covered by the numeric forms, and an entity this table does not know is left
 * INTACT rather than destroyed (see `decodeEntity`).
 *
 * Every entry decodes to the character it actually denotes, INCLUDING the
 * invisible ones. Nothing here maps to a "convenient" substitute: making the
 * text faithful is this function's whole job, and `normalizeForSearch` is where
 * invisibles stop mattering for MATCHING.
 */
const ENTITIES: Record<string, string> = {
	// structural
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
	// spacing family — decoded to the real space characters they denote. Leaving
	// these intact would glue two words together with literal "&thinsp;" between
	// them, which is strictly worse than the space the old code produced.
	'&nbsp;': ' ',
	'&NonBreakingSpace;': ' ',
	'&ensp;': ' ',
	'&emsp;': ' ',
	'&emsp13;': ' ',
	'&emsp14;': ' ',
	'&numsp;': ' ',
	'&puncsp;': ' ',
	'&thinsp;': ' ',
	'&ThinSpace;': ' ',
	'&hairsp;': ' ',
	'&VeryThinSpace;': ' ',
	// zero-width / invisible formatting — real characters, stripped when matching
	'&shy;': '­',
	'&ZeroWidthSpace;': '​',
	'&zwnj;': '‌',
	'&zwj;': '‍',
	'&lrm;': '‎',
	'&rlm;': '‏',
	// typographic punctuation
	'&rsquo;': '’',
	'&lsquo;': '‘',
	'&rdquo;': '”',
	'&ldquo;': '“',
	'&sbquo;': '‚',
	'&bdquo;': '„',
	'&ndash;': '–',
	'&mdash;': '—',
	'&hellip;': '…',
	'&middot;': '·',
	'&bull;': '•',
	'&dagger;': '†',
	'&laquo;': '«',
	'&raquo;': '»',
	'&prime;': '′',
	'&Prime;': '″',
	'&deg;': '°',
	'&times;': '×',
	'&divide;': '÷',
	'&frac12;': '½',
	'&frac14;': '¼',
	'&frac34;': '¾',
	// currency / legal / commercial marks
	'&reg;': '®',
	'&copy;': '©',
	'&trade;': '™',
	'&euro;': '€',
	'&pound;': '£',
	'&cent;': '¢',
	'&yen;': '¥',
	'&sect;': '§',
	'&para;': '¶',
	// accented letters, both cases — a menu's café, jalapeño, crème brûlée, açaí
	'&aacute;': 'á',
	'&Aacute;': 'Á',
	'&agrave;': 'à',
	'&Agrave;': 'À',
	'&acirc;': 'â',
	'&Acirc;': 'Â',
	'&auml;': 'ä',
	'&Auml;': 'Ä',
	'&aring;': 'å',
	'&Aring;': 'Å',
	'&aelig;': 'æ',
	'&AElig;': 'Æ',
	'&ccedil;': 'ç',
	'&Ccedil;': 'Ç',
	'&eacute;': 'é',
	'&Eacute;': 'É',
	'&egrave;': 'è',
	'&Egrave;': 'È',
	'&ecirc;': 'ê',
	'&Ecirc;': 'Ê',
	'&euml;': 'ë',
	'&Euml;': 'Ë',
	'&iacute;': 'í',
	'&Iacute;': 'Í',
	'&icirc;': 'î',
	'&Icirc;': 'Î',
	'&iuml;': 'ï',
	'&Iuml;': 'Ï',
	'&ntilde;': 'ñ',
	'&Ntilde;': 'Ñ',
	'&oacute;': 'ó',
	'&Oacute;': 'Ó',
	'&ocirc;': 'ô',
	'&Ocirc;': 'Ô',
	'&ouml;': 'ö',
	'&Ouml;': 'Ö',
	'&oslash;': 'ø',
	'&Oslash;': 'Ø',
	'&szlig;': 'ß',
	'&uacute;': 'ú',
	'&Uacute;': 'Ú',
	'&ucirc;': 'û',
	'&Ucirc;': 'Û',
	'&uuml;': 'ü',
	'&Uuml;': 'Ü'
};

/**
 * The only named entities HTML5 also defines in uppercase. The lowercase
 * fallback is restricted to these, so `&AMP;` decodes while `&EACUTE;` — which
 * is NOT a valid entity — is left intact instead of silently decoding to a
 * lowercase `é` and corrupting the case of a real word.
 */
const UPPERCASE_ALIASES = new Set([
	'&amp;',
	'&copy;',
	'&gt;',
	'&lt;',
	'&quot;',
	'&reg;',
	'&trade;'
]);

/**
 * Code points 0x80–0x9F are C1 controls in Unicode, but HTML requires them to be
 * interpreted as windows-1252 — legacy CMSes emit `&#146;` meaning `’` and
 * `&#151;` meaning `—`. Following the spec turns those into real punctuation
 * instead of injecting an unprintable control character.
 */
const WINDOWS_1252: Record<number, string> = {
	0x80: '€',
	0x82: '‚',
	0x83: 'ƒ',
	0x84: '„',
	0x85: '…',
	0x86: '†',
	0x87: '‡',
	0x88: 'ˆ',
	0x89: '‰',
	0x8a: 'Š',
	0x8b: '‹',
	0x8c: 'Œ',
	0x8e: 'Ž',
	0x91: '‘',
	0x92: '’',
	0x93: '“',
	0x94: '”',
	0x95: '•',
	0x96: '–',
	0x97: '—',
	0x98: '˜',
	0x99: '™',
	0x9a: 'š',
	0x9b: '›',
	0x9c: 'œ',
	0x9e: 'ž',
	0x9f: 'Ÿ'
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
 * A literal `&hearts;` surviving in the text is noise; a deleted letter is a
 * wrong answer, so an unknown entity decodes to itself.
 *
 * The one thing that rule must NOT be applied to is an entity that denotes
 * WHITESPACE. `Fish&thinsp;&amp;&thinsp;Chips` has to come out as text a gold
 * name can match, so the spacing family is in the table above and decodes to the
 * real space characters. Anything invisible that survives is handled once, in
 * `normalizeForSearch`, rather than guessed at per entity here.
 */
function decodeEntity(entity: string): string {
	const exact = ENTITIES[entity];
	if (exact !== undefined) return exact;
	const lower = entity.toLowerCase();
	if (UPPERCASE_ALIASES.has(lower)) return ENTITIES[lower];

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
	return WINDOWS_1252[code] ?? String.fromCodePoint(code);
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
 *
 * Invisible characters are then removed outright, and non-whitespace control
 * characters become a space. A zero-width space, a soft hyphen or a zero-width
 * joiner renders as NOTHING, so a reader — and therefore the gold author — never
 * sees it; but JS `\s` does not match any of them, so left alone they sit inside
 * a word and guarantee the membership check fails. Doing it here rather than at
 * decode time covers the character however it arrived: as `&shy;`, as `&#173;`,
 * or as a literal byte in the page.
 */
export function normalizeForSearch(text: string): string {
	return (
		text
			.normalize('NFC')
			.replace(/[\u2019\u2018\u02BC\u00B4`]/g, "'")
			.toLowerCase()
			// Zero-width and bidi formatting characters, plus the soft hyphen: invisible
			// to a reader, so they must be invisible to matching too.
			.replace(/[\u00AD\p{Cf}]/gu, '')
			// Control characters that are not ordinary whitespace still separate words.
			.replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * Name-matching key: paren-insensitive form of a name, with whitespace collapsed
 * away INSIDE each parenthetical so trivial spacing differences in a variant
 * label never split a match. Within every balanced `(…)` group all whitespace is
 * removed (`(5 oz glass)` and `(5oz glass)` both key to `5ozglass`; `(8 oz)` and
 * `(8oz)` both to `8oz`), the group is bounded by spaces, and any stray unbalanced
 * paren is dropped to a space; then `normalizeForSearch` lowercases and collapses
 * the OUTSIDE whitespace. So "Fresh Soup (Bowl)" still keys identically to "Fresh
 * Soup Bowl", "Soup(bowl)" keys as "soup bowl" (not "soupbowl"), and a candidate
 * matches a gold variant regardless of the source's parenthesization OR its
 * spacing inside the label. Whitespace BETWEEN words outside parens still matters.
 *
 * This is the scorer's notion of item IDENTITY, and it lives here rather than in
 * `score.ts` so the linter can enforce uniqueness under the same key. (`score.ts`
 * re-exports it, so callers are unaffected.)
 */
export function nameMatchKey(name: string): string {
	const collapsed = name
		.replace(/\(([^()]*)\)/g, (_m, inner: string) => ` ${inner.replace(/\s+/g, '')} `)
		.replace(/[()]/g, ' ');
	return normalizeForSearch(collapsed);
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
		// Uniqueness is checked under the SCORER's key, not the corpus key. The
		// scorer matches on `nameMatchKey`, which drops parentheses — so gold
		// carrying both "Bacon Double Cheese (Dog)" and "Bacon Double Cheese Dog"
		// used to pass this check, and then `matchItems` silently kept only the
		// first: 100% recall became unreachable and the dropped row did not even
		// appear in `missed_items`. Two names the scorer cannot tell apart are a
		// duplicate here, whatever they look like.
		const dupKey = nameMatchKey(item.name);
		if (seen.has(dupKey)) errors.push(`${label}: duplicate item name`);
		seen.add(dupKey);

		// Corpus membership uses the plain key: the snapshot holds the source's
		// literal text, parentheses and all.
		const nameKey = normalizeForSearch(item.name);

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
	// A path that is not a task directory is an ERROR, never a skip. Reporting a
	// mistyped slug as "no gold authored yet" asserts a state that does not exist
	// — the task is not unauthored, it is not there — and as a skip it would also
	// be silent in scan mode.
	if (!isDirectory(taskDir)) {
		return { errors: [`not a task directory: ${taskDir}`], warnings: [] };
	}

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
	const result = lintGold(goldRaw, buildCorpus(store), recordedUrls);

	// The manifest's own warnings ("page budget exhausted with 154 URLs
	// unvisited") describe the SNAPSHOT, not the gold, and they are identical on
	// every run until the venue is re-recorded — so they are reported only when
	// this lint found something they could EXPLAIN.
	//
	// They are not dropped outright, because for the one task that has them they
	// are the cause of the finding directly above: New York Fries has a gold
	// description missing from its snapshot AND a snapshot 154 pages short, and
	// separating those two lines leaves an unexplained "not found verbatim". Nor
	// are they printed unconditionally, which is what buried them. (`bench:record`
	// prints them once at record time and nothing else reads them, so this is
	// currently their only durable reader — surfacing snapshot health in
	// `bench:new --status` would be the better long-term home.)
	if (result.errors.length > 0 || result.warnings.length > 0) {
		for (const w of manifest.warnings) result.warnings.push(`manifest: ${w}`);
	}
	return result;
}

/** True when the path exists and is a directory; false on anything unreadable. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export type TaskDirResolution =
	| { kind: 'explicit'; dirs: string[] }
	| { kind: 'scan'; dirs: string[] }
	| { kind: 'nothing'; note: string };

/**
 * Which directories a `bench:lint` invocation should lint.
 *
 * Explicitly named dirs are linted exactly as given. A bare scan takes only
 * DIRECTORIES, so a stray file under `bench/tasks` (a `.DS_Store`, a `notes.md`)
 * cannot fail the run with a confusing "no manifest.json" for a non-task — but
 * the two "nothing to lint" cases are reported distinctly, since a root holding
 * only files is not the same fact as an absent or empty root.
 */
export function resolveTaskDirs(args: readonly string[], tasksRoot: string): TaskDirResolution {
	if (args.length > 0) return { kind: 'explicit', dirs: [...args] };

	// bench data deliberately lives outside git — on CI there is nothing to lint
	if (!existsSync(tasksRoot)) {
		return { kind: 'nothing', note: `no ${tasksRoot} directory — nothing to lint (skipping)` };
	}
	const entries = readdirSync(tasksRoot);
	const dirs = entries.map((d) => join(tasksRoot, d)).filter(isDirectory);
	if (dirs.length > 0) return { kind: 'scan', dirs };
	return {
		kind: 'nothing',
		note:
			entries.length === 0
				? `${tasksRoot} is empty — nothing to lint (skipping)`
				: `${tasksRoot} holds no task directories (${entries.length} non-directory entr(y|ies)) — nothing to lint (skipping)`
	};
}

export interface LintRunResult {
	failed: boolean;
	/** Human lines, in order. Returned rather than printed so this is testable. */
	lines: string[];
}

/**
 * Lint every directory and render the report.
 *
 * `explicit` decides what a SKIP means: when the caller named this task, a task
 * with nothing to lint is a failure; in a bare scan it is normal. Skips are
 * counted into a trailing summary either way — three of them scrolling past
 * above a row of `ok`s is how a mis-shaped task tree (a nested
 * `bench/tasks/<group>/<slug>` layout, say, whose every gold goes unlinted)
 * reads as green.
 */
export function runLint(taskDirs: readonly string[], explicit: boolean): LintRunResult {
	const lines: string[] = [];
	let failed = false;
	let skippedCount = 0;

	for (const dir of taskDirs) {
		const { errors, warnings, skipped } = lintTask(dir);
		if (skipped !== undefined && !explicit) {
			skippedCount += 1;
			lines.push(`skip  ${dir}`, `  ${skipped}`);
			continue;
		}
		const allErrors = skipped !== undefined ? [...errors, skipped] : errors;
		lines.push(`${(allErrors.length > 0 ? 'FAIL' : 'ok').padEnd(5)} ${dir}`);
		for (const e of allErrors) lines.push(`  error: ${e}`);
		for (const w of warnings) lines.push(`  warning: ${w}`);
		if (allErrors.length > 0) failed = true;
	}

	if (skippedCount > 0) {
		lines.push(
			`${skippedCount} of ${taskDirs.length} task(s) skipped (nothing to lint yet) — ` +
				'name one explicitly to see it as a failure'
		);
	}
	return { failed, lines };
}

if (import.meta.main) {
	const resolved = resolveTaskDirs(process.argv.slice(2), 'bench/tasks');
	if (resolved.kind === 'nothing') {
		console.error(resolved.note);
		process.exit(0);
	}
	const { failed, lines } = runLint(resolved.dirs, resolved.kind === 'explicit');
	for (const line of lines) console.error(line);
	process.exit(failed ? 1 : 0);
}
