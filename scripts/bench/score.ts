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
	description_accuracy: number;
	source_recall: number;
	source_precision: number;
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

interface Pair {
	gold: MenuItem;
	candidate: MenuItem;
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
	const goldByKey = new Map<string, MenuItem>();
	for (const item of gold.items) goldByKey.set(normalizeForSearch(item.name), item);

	const pairs: Pair[] = [];
	const hallucinated: MenuItem[] = [];
	const usedGoldKeys = new Set<string>();

	for (const cand of candidate.items) {
		const key = normalizeForSearch(cand.name);
		const goldItem = goldByKey.get(key);
		if (goldItem && !usedGoldKeys.has(key)) {
			usedGoldKeys.add(key);
			pairs.push({ gold: goldItem, candidate: cand });
		} else {
			hallucinated.push(cand);
		}
	}

	const missed = gold.items.filter((g) => !usedGoldKeys.has(normalizeForSearch(g.name)));
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
		const goldExpanded = expandTags(gold[field]);
		const candExpanded = expandTags(candidate[field]);
		goldTotal += goldExpanded.size;
		candTotal += candExpanded.size;
		for (const tag of candExpanded) {
			if (goldExpanded.has(tag)) tp += 1;
			else falsePositives.push({ item: candidate.name, tag });
		}
	}

	return {
		precision: ratio(tp, candTotal),
		recall: ratio(tp, goldTotal),
		falsePositives
	};
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
	for (const { gold: g, candidate: c } of pairs) {
		if (g.price === c.price) priceHits += 1;
		const descMatch =
			g.description === null || c.description === null
				? g.description === c.description
				: normalizeForSearch(g.description) === normalizeForSearch(c.description);
		if (descMatch) descHits += 1;
	}

	const goldSources = sourceSet(gold.sources);
	const candSources = sourceSet(candidate.sources);
	let sourceHits = 0;
	for (const s of candSources) if (goldSources.has(s)) sourceHits += 1;

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
		description_accuracy: ratio(descHits, matched),
		source_recall: ratio(sourceHits, goldSources.size),
		source_precision: ratio(sourceHits, candSources.size)
	};
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
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
		`price      ${pct(report.price_accuracy)}   description ${pct(report.description_accuracy)}`,
		`sources    recall ${pct(report.source_recall)}  precision ${pct(report.source_precision)}`
	];
	for (const fp of report.tag_false_positives) {
		lines.push(`  ! false-positive tag: "${fp.item}" asserts ${fp.tag}`);
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
