/**
 * Bench scorer.
 *
 * Deterministically scores a candidate menu extraction (an agent's output)
 * against a task's hand-authored gold. NO fuzzy matching, NO LLM: candidate
 * items match gold items only by exact equality of normalizeForSearch(name).
 *
 * The report is a metric VECTOR, never a single number — recall and precision
 * are kept apart everywhere (a hallucinated free-of tag is a safety problem; a
 * missed tag is a completeness problem), so they must never be averaged
 * together.
 *
 * Usage:
 *   bun run bench:score <task-dir> <candidate-output.json>
 *
 * Writes the JSON report to stdout (pipe/save it) and a short human summary to
 * stderr. Exit 0 on a successful scoring regardless of how bad the scores are;
 * exit 2 when the candidate (or gold) file is missing/invalid.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { GoldSchema, normalizeForSearch, type GoldMenu } from './lint';
import { normalizeUrl } from './snapshot-store';

// A candidate is shaped exactly like gold, except policy_version is optional —
// an agent need not stamp the policy it was authored under.
export const CandidateSchema = v.object({
	...GoldSchema.entries,
	policy_version: v.optional(v.string())
});

export type CandidateMenu = v.InferOutput<typeof CandidateSchema>;
type MenuItem = GoldMenu['items'][number];

export interface TagFalsePositive {
	item: string;
	tag: string;
	/**
	 * Set only when this false-positive tag was NOT in the candidate's literal
	 * tag list for the item but appeared through `expandTags` — i.e. the model
	 * never asserted it directly, an implication did. Holds the raw tag that
	 * implied it (with the current table, always `vegan`). Diagnostics only:
	 * precision/recall counts are unaffected.
	 */
	implied_by?: string;
}

/** A matched pair whose price disagrees; gold/candidate hold the raw prices. */
export interface PriceMismatch {
	item: string;
	gold: number | null;
	candidate: number | null;
}

/**
 * A matched pair whose description disagrees after normalization; gold/candidate
 * hold the RAW description text (or null) so the summary can show what differs.
 */
export interface DescriptionMismatch {
	item: string;
	gold: string | null;
	candidate: string | null;
}

export interface ScoreReport {
	gold_items: number;
	candidate_items: number;
	matched: number;
	item_recall: number;
	item_precision: number;
	missed_items: string[];
	hallucinated_items: string[];
	tag_precision: number;
	tag_recall: number;
	optional_tag_precision: number;
	optional_tag_recall: number;
	tag_false_positives: TagFalsePositive[];
	price_accuracy: number;
	/** Matched pairs whose price differs (candidate vs gold), sorted by item name. */
	price_mismatches: PriceMismatch[];
	description_accuracy: number;
	/** Matched pairs whose description differs after normalization, sorted by item name. */
	description_mismatches: DescriptionMismatch[];
	/**
	 * Presence-only agreement on the `warning` flag over matched pairs: a warning
	 * is "present" iff it is a string, "absent" for null/undefined/missing. The
	 * warning CONTENT is never compared — only whether each side flagged the item.
	 */
	warning_accuracy: number;
	missing_warnings: string[];
	spurious_warnings: string[];
	source_recall: number;
	source_precision: number;
	/**
	 * Candidate source URLs that were IGNORED for precision: a site ROOT page
	 * (normalized pathname exactly "/" with no query string) that gold does not
	 * itself list. Such a URL counts as neither a hit nor a miss — it is excluded
	 * from the precision denominator entirely (see `scoreCandidate`). Sorted.
	 * A root URL that gold DOES list is a normal hit and never appears here.
	 */
	ignored_sources: string[];
}

/** 0/0 counts as a perfect ratio: nothing was asserted, so nothing is wrong or missing. */
function ratio(hit: number, total: number): number {
	return total === 0 ? 1 : hit / total;
}

/**
 * Expand the vegan implication on a tag set: gold stores tags minimally, so
 * vegan alone stands in for vegan + vegetarian + dairy_free. Applied to BOTH
 * sides (and to optional_tags too) before any comparison.
 */
export function expandTags(tags: readonly string[]): Set<string> {
	const out = new Set(tags);
	if (out.has('vegan')) {
		out.add('vegetarian');
		out.add('dairy_free');
	}
	return out;
}

/**
 * Given the candidate's raw (pre-expansion) tags and an expanded tag NOT among
 * them, find the raw tag whose implication produced it — derived from
 * `expandTags`, not hardcoded. Returns undefined if no raw tag implies it.
 */
function impliedBy(rawTags: readonly string[], tag: string): string | undefined {
	for (const raw of rawTags) {
		if (raw !== tag && expandTags([raw]).has(tag)) return raw;
	}
	return undefined;
}

interface Pair {
	gold: MenuItem;
	candidate: MenuItem;
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
 */
export function nameMatchKey(name: string): string {
	const collapsed = name
		.replace(/\(([^()]*)\)/g, (_m, inner: string) => ` ${inner.replace(/\s+/g, '')} `)
		.replace(/[()]/g, ' ');
	return normalizeForSearch(collapsed);
}

/**
 * Match candidate items to gold items by exact normalized-name equality. Each
 * gold item matches at most one candidate and vice versa; a candidate name that
 * repeats matches on its FIRST occurrence, later copies fall through as
 * hallucinations (gold names are unique by construction).
 */
function matchItems(
	gold: GoldMenu,
	candidate: CandidateMenu
): {
	pairs: Pair[];
	missed: MenuItem[];
	hallucinated: MenuItem[];
} {
	// First-in wins: gold names are unique by lint, but two gold names COULD
	// collide once parens are stripped ("X (a)" vs "X a") — gold should not
	// contain such paren-insensitive duplicate names. On collision we keep the
	// first-seen item so matching stays deterministic (never crash on odd gold).
	const goldByKey = new Map<string, MenuItem>();
	for (const item of gold.items) {
		const key = nameMatchKey(item.name);
		if (!goldByKey.has(key)) goldByKey.set(key, item);
	}

	const pairs: Pair[] = [];
	const hallucinated: MenuItem[] = [];
	const usedGoldKeys = new Set<string>();

	for (const cand of candidate.items) {
		const key = nameMatchKey(cand.name);
		const goldItem = goldByKey.get(key);
		if (goldItem && !usedGoldKeys.has(key)) {
			usedGoldKeys.add(key);
			pairs.push({ gold: goldItem, candidate: cand });
		} else {
			hallucinated.push(cand);
		}
	}

	const missed = gold.items.filter((g) => !usedGoldKeys.has(nameMatchKey(g.name)));
	return { pairs, missed, hallucinated };
}

/** Micro-averaged precision/recall over the expanded tag sets of matched pairs. */
function scoreTagField(
	pairs: Pair[],
	field: 'tags' | 'optional_tags'
): {
	precision: number;
	recall: number;
	falsePositives: TagFalsePositive[];
} {
	let tp = 0;
	let candTotal = 0;
	let goldTotal = 0;
	const falsePositives: TagFalsePositive[] = [];

	for (const { gold, candidate } of pairs) {
		const rawCand = candidate[field];
		// Widened deliberately: the candidate's tags are a narrow union, but the set
		// we probe with is the EXPANDED one (`Set<string>`), so a narrow Set would
		// reject the lookup. The membership test is what matters, not the arity.
		const literalTags = new Set<string>(rawCand);
		const goldExpanded = expandTags(gold[field]);
		const candExpanded = expandTags(rawCand);
		goldTotal += goldExpanded.size;
		candTotal += candExpanded.size;
		for (const tag of candExpanded) {
			if (goldExpanded.has(tag)) {
				tp += 1;
				continue;
			}
			const fp: TagFalsePositive = { item: candidate.name, tag };
			if (!literalTags.has(tag)) {
				const source = impliedBy(rawCand, tag);
				if (source !== undefined) fp.implied_by = source;
			}
			falsePositives.push(fp);
		}
	}

	return {
		precision: ratio(tp, candTotal),
		recall: ratio(tp, goldTotal),
		falsePositives
	};
}

/**
 * A source URL is a site ROOT if, after `normalizeUrl`, its pathname is exactly
 * "/" and it carries no query string (a homepage like "https://x.com/"). An
 * unparseable URL is never a root.
 */
function isRootUrl(normalized: string): boolean {
	try {
		const u = new URL(normalized);
		return u.pathname === '/' && u.search === '';
	} catch {
		return false;
	}
}

function sourceSet(urls: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const url of urls) {
		try {
			out.add(normalizeUrl(url));
		} catch {
			out.add(url);
		}
	}
	return out;
}

/** Pure scorer: gold + candidate (both schema-valid) → the full metric vector. */
export function scoreCandidate(gold: GoldMenu, candidate: CandidateMenu): ScoreReport {
	const { pairs, missed, hallucinated } = matchItems(gold, candidate);
	const matched = pairs.length;

	const tags = scoreTagField(pairs, 'tags');
	const optional = scoreTagField(pairs, 'optional_tags');

	let priceHits = 0;
	let descHits = 0;
	let warningHits = 0;
	const priceMismatches: PriceMismatch[] = [];
	const descriptionMismatches: DescriptionMismatch[] = [];
	const missingWarnings: string[] = [];
	const spuriousWarnings: string[] = [];
	for (const { gold: g, candidate: c } of pairs) {
		if (g.price === c.price) priceHits += 1;
		else priceMismatches.push({ item: g.name, gold: g.price, candidate: c.price });
		const descMatch =
			g.description === null || c.description === null
				? g.description === c.description
				: normalizeForSearch(g.description) === normalizeForSearch(c.description);
		if (descMatch) descHits += 1;
		else
			descriptionMismatches.push({ item: g.name, gold: g.description, candidate: c.description });

		// Presence-only: content is never compared.
		const goldHasWarning = typeof g.warning === 'string';
		const candHasWarning = typeof c.warning === 'string';
		if (goldHasWarning === candHasWarning) warningHits += 1;
		else if (goldHasWarning) missingWarnings.push(g.name);
		else spuriousWarnings.push(c.name);
	}

	const goldSources = sourceSet(gold.sources);
	const candSources = sourceSet(candidate.sources);
	let sourceHits = 0;
	const ignoredSources: string[] = [];
	for (const s of candSources) {
		if (goldSources.has(s)) {
			sourceHits += 1;
		} else if (isRootUrl(s)) {
			ignoredSources.push(s);
		}
	}
	const candSourceDenom = candSources.size - ignoredSources.length;

	return {
		gold_items: gold.items.length,
		candidate_items: candidate.items.length,
		matched,
		item_recall: ratio(matched, gold.items.length),
		item_precision: ratio(matched, candidate.items.length),
		missed_items: missed.map((i) => i.name).toSorted((a, b) => a.localeCompare(b)),
		hallucinated_items: hallucinated.map((i) => i.name).toSorted((a, b) => a.localeCompare(b)),
		tag_precision: tags.precision,
		tag_recall: tags.recall,
		optional_tag_precision: optional.precision,
		optional_tag_recall: optional.recall,
		tag_false_positives: tags.falsePositives.toSorted(
			(a, b) => a.item.localeCompare(b.item) || a.tag.localeCompare(b.tag)
		),
		price_accuracy: ratio(priceHits, matched),
		price_mismatches: priceMismatches.toSorted((a, b) => a.item.localeCompare(b.item)),
		description_accuracy: ratio(descHits, matched),
		description_mismatches: descriptionMismatches.toSorted((a, b) => a.item.localeCompare(b.item)),
		warning_accuracy: ratio(warningHits, matched),
		missing_warnings: missingWarnings.toSorted((a, b) => a.localeCompare(b)),
		spurious_warnings: spuriousWarnings.toSorted((a, b) => a.localeCompare(b)),
		source_recall: ratio(sourceHits, goldSources.size),
		source_precision: ratio(sourceHits, candSourceDenom),
		ignored_sources: ignoredSources.toSorted((a, b) => a.localeCompare(b))
	};
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtPrice(p: number | null): string {
	return p === null ? 'null' : String(p);
}

/** Quote a description (or mark it absent) so trailing/whitespace diffs are visible. */
function fmtDesc(d: string | null): string {
	return d === null ? '(none)' : JSON.stringify(d);
}

/** Short human-readable summary for stderr. */
export function formatSummary(report: ScoreReport): string {
	const lines = [
		`items      ${report.matched}/${report.gold_items} matched  ` +
			`recall ${pct(report.item_recall)}  precision ${pct(report.item_precision)}`,
		`  missed ${report.missed_items.length}, hallucinated ${report.hallucinated_items.length}`,
		`tags       recall ${pct(report.tag_recall)}  precision ${pct(report.tag_precision)}` +
			`  (${report.tag_false_positives.length} false-positive tag(s))`,
		`opt.tags   recall ${pct(report.optional_tag_recall)}  precision ${pct(report.optional_tag_precision)}`,
		`price      ${pct(report.price_accuracy)} (${report.price_mismatches.length} mismatched)   ` +
			`description ${pct(report.description_accuracy)} (${report.description_mismatches.length} mismatched)`,
		`warnings   ${pct(report.warning_accuracy)}` +
			`  (${report.missing_warnings.length} missing, ${report.spurious_warnings.length} spurious)`,
		`sources    recall ${pct(report.source_recall)}  precision ${pct(report.source_precision)}` +
			(report.ignored_sources.length === 0
				? ''
				: `  (${report.ignored_sources.length} root URL${report.ignored_sources.length === 1 ? '' : 's'} ignored)`)
	];
	for (const fp of report.tag_false_positives) {
		const suffix = fp.implied_by === undefined ? '' : ` (implied by ${fp.implied_by})`;
		lines.push(`  ! false-positive tag: "${fp.item}" asserts ${fp.tag}${suffix}`);
	}
	for (const m of report.price_mismatches) {
		lines.push(
			`  ! price differs: "${m.item}" gold ${fmtPrice(m.gold)} vs candidate ${fmtPrice(m.candidate)}`
		);
	}
	for (const m of report.description_mismatches) {
		lines.push(`  ! description differs: "${m.item}"`);
		lines.push(`      gold: ${fmtDesc(m.gold)}`);
		lines.push(`      cand: ${fmtDesc(m.candidate)}`);
	}
	for (const name of report.missing_warnings) {
		lines.push(`  ! missing warning: "${name}" (gold flags it, candidate does not)`);
	}
	for (const name of report.spurious_warnings) {
		lines.push(`  ! spurious warning: "${name}" (candidate flags it, gold does not)`);
	}
	return lines.join('\n');
}

/** Parse + schema-validate a JSON file; returns the value or a list of problems. */
function loadValidated<T>(
	path: string,
	schema: v.GenericSchema<unknown, T>,
	label: string
): { ok: true; value: T } | { ok: false; problems: string[] } {
	if (!existsSync(path)) {
		return { ok: false, problems: [`${label}: file not found: ${path}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf-8'));
	} catch (e) {
		return { ok: false, problems: [`${label}: not valid JSON: ${String(e)}`] };
	}
	const parsed = v.safeParse(schema, raw);
	if (!parsed.success) {
		return {
			ok: false,
			problems: parsed.issues
				.slice(0, 10)
				.map((issue) => `${label}: ${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
		};
	}
	return { ok: true, value: parsed.output };
}

if (import.meta.main) {
	const [taskDir, candidatePath] = process.argv.slice(2);
	if (!taskDir || !candidatePath) {
		console.error('usage: bun run bench:score <task-dir> <candidate-output.json>');
		process.exit(2);
	}

	const gold = loadValidated(join(taskDir, 'gold', 'data.json'), GoldSchema, 'gold');
	if (!gold.ok) {
		for (const p of gold.problems) console.error(p);
		process.exit(2);
	}

	const candidate = loadValidated(candidatePath, CandidateSchema, 'candidate');
	if (!candidate.ok) {
		for (const p of candidate.problems) console.error(p);
		process.exit(2);
	}

	const report = scoreCandidate(gold.value, candidate.value);
	process.stdout.write(JSON.stringify(report, null, '\t') + '\n');
	console.error(formatSummary(report));
	process.exit(0);
}
