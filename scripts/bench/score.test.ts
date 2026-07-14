import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as v from 'valibot';
import { GoldSchema } from './lint';
import { CandidateSchema, expandTags, formatSummary, scoreCandidate } from './score';

const baseGold = {
	policy_version: '2026-07-11',
	sources: ['https://x.com/menu'],
	items: [
		{
			name: 'Vegan Burger',
			description: 'House patty',
			tags: ['vegan'],
			optional_tags: [],
			price: 14
		},
		{ name: 'Fries', description: null, tags: [], optional_tags: ['vegan'], price: 6 }
	]
};

function gold(overrides?: unknown): v.InferOutput<typeof GoldSchema> {
	return v.parse(GoldSchema, overrides ?? structuredClone(baseGold));
}
function cand(value: unknown): v.InferOutput<typeof CandidateSchema> {
	return v.parse(CandidateSchema, value);
}

describe('expandTags', () => {
	test('vegan implies vegetarian + dairy_free', () => {
		expect([...expandTags(['vegan'])].toSorted()).toEqual(['dairy_free', 'vegan', 'vegetarian']);
	});
	test('non-vegan tags pass through unchanged', () => {
		expect([...expandTags(['gluten_friendly'])]).toEqual(['gluten_friendly']);
	});
});

describe('scoreCandidate', () => {
	test('perfect self-match: all ratios 1, all lists empty', () => {
		const g = gold();
		const r = scoreCandidate(g, cand(structuredClone(baseGold)));
		expect(r.item_recall).toBe(1);
		expect(r.item_precision).toBe(1);
		expect(r.tag_precision).toBe(1);
		expect(r.tag_recall).toBe(1);
		expect(r.optional_tag_precision).toBe(1);
		expect(r.optional_tag_recall).toBe(1);
		expect(r.price_accuracy).toBe(1);
		expect(r.description_accuracy).toBe(1);
		expect(r.source_recall).toBe(1);
		expect(r.source_precision).toBe(1);
		expect(r.missed_items).toEqual([]);
		expect(r.hallucinated_items).toEqual([]);
		expect(r.tag_false_positives).toEqual([]);
		expect(r.price_mismatches).toEqual([]);
		expect(r.description_mismatches).toEqual([]);
		expect(r.matched).toBe(2);
	});

	test('candidate is optional policy_version-free', () => {
		const c = structuredClone(baseGold) as Record<string, unknown>;
		delete c.policy_version;
		const r = scoreCandidate(gold(), cand(c));
		expect(r.matched).toBe(2);
	});

	test('missed and hallucinated items', () => {
		const c = structuredClone(baseGold);
		c.items = [
			c.items[0],
			{ name: 'Onion Rings', description: null, tags: [], optional_tags: [], price: 5 }
		];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.matched).toBe(1);
		expect(r.item_recall).toBe(0.5);
		expect(r.item_precision).toBe(0.5);
		expect(r.missed_items).toEqual(['Fries']);
		expect(r.hallucinated_items).toEqual(['Onion Rings']);
	});

	test('implication expansion scores perfect both directions', () => {
		// gold minimal vegan vs candidate fully-expanded
		const expanded = structuredClone(baseGold);
		expanded.items[0].tags = ['vegan', 'vegetarian', 'dairy_free'];
		const r1 = scoreCandidate(gold(), cand(expanded));
		expect(r1.tag_precision).toBe(1);
		expect(r1.tag_recall).toBe(1);
		expect(r1.tag_false_positives).toEqual([]);

		// reverse: gold expanded, candidate minimal
		const g2 = gold(expanded);
		const r2 = scoreCandidate(g2, cand(structuredClone(baseGold)));
		expect(r2.tag_precision).toBe(1);
		expect(r2.tag_recall).toBe(1);
	});

	test('a free-of false positive shows up and drops tag_precision', () => {
		const c = structuredClone(baseGold);
		c.items[0].tags = ['vegan', 'gluten_friendly'];
		const r = scoreCandidate(gold(), cand(c));
		// literally asserted wrong tag → no implied_by
		expect(r.tag_false_positives).toEqual([{ item: 'Vegan Burger', tag: 'gluten_friendly' }]);
		expect(r.tag_false_positives[0].implied_by).toBeUndefined();
		expect(r.tag_precision).toBeLessThan(1);
		// recall stays perfect — nothing gold asserted was missed
		expect(r.tag_recall).toBe(1);
	});

	test('implied false positives are annotated; literal ones are not', () => {
		// gold's Fries has no tags; candidate wrongly tags Fries vegan, which
		// expands to vegan+vegetarian+dairy_free — three FPs gold lacks.
		const c = structuredClone(baseGold);
		c.items[1].tags = ['vegan'];
		const r = scoreCandidate(gold(), cand(c));

		const byTag = new Map(r.tag_false_positives.map((fp) => [fp.tag, fp]));
		expect([...byTag.keys()].toSorted()).toEqual(['dairy_free', 'vegan', 'vegetarian']);
		// the literally-asserted vegan carries no implied_by
		expect(byTag.get('vegan')?.implied_by).toBeUndefined();
		// the two implied tags are annotated as implied by vegan
		expect(byTag.get('vegetarian')?.implied_by).toBe('vegan');
		expect(byTag.get('dairy_free')?.implied_by).toBe('vegan');

		// metric MATH is unchanged by the annotation. Fries: gold 0 tags,
		// candidate 3 expanded → 0 tp. Vegan Burger: 3/3 tp both sides.
		// precision = 3 / (3 + 3) = 0.5; recall = 3 / 3 = 1.
		expect(r.tag_precision).toBe(0.5);
		expect(r.tag_recall).toBe(1);

		// formatSummary renders the "(implied by vegan)" suffix for implied FPs
		const summary = formatSummary(r);
		expect(summary).toContain(
			'! false-positive tag: "Fries" asserts dairy_free (implied by vegan)'
		);
		expect(summary).toContain(
			'! false-positive tag: "Fries" asserts vegetarian (implied by vegan)'
		);
		// the literal vegan FP has no suffix
		expect(summary).toContain('! false-positive tag: "Fries" asserts vegan\n');
	});

	test('duplicate candidate names: first matches, rest hallucinate', () => {
		const c = structuredClone(baseGold);
		c.items = [c.items[0], { ...c.items[0], price: 99 }, c.items[1]];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.matched).toBe(2);
		expect(r.candidate_items).toBe(3);
		expect(r.hallucinated_items).toEqual(['Vegan Burger']);
		expect(r.item_precision).toBeCloseTo(2 / 3);
		// the FIRST occurrence (correct price) is the matched one
		expect(r.price_accuracy).toBe(1);
	});

	test('candidate matches gold variant name ignoring parentheses (both directions)', () => {
		// gold has a parenthesized variant, candidate drops the parens
		const g = structuredClone(baseGold);
		g.items[1] = { ...g.items[1], name: 'Fresh Soup (bowl)' };
		const c = structuredClone(baseGold);
		c.items[1] = { ...c.items[1], name: 'Fresh Soup bowl' };
		const r = scoreCandidate(gold(g), cand(c));
		expect(r.matched).toBe(2);
		expect(r.missed_items).toEqual([]);
		expect(r.hallucinated_items).toEqual([]);

		// reverse: gold drops the parens, candidate has them
		const r2 = scoreCandidate(gold(c), cand(g));
		expect(r2.matched).toBe(2);
		expect(r2.missed_items).toEqual([]);
		expect(r2.hallucinated_items).toEqual([]);
	});

	test('parentheses without surrounding spaces still match', () => {
		const g = structuredClone(baseGold);
		g.items[1] = { ...g.items[1], name: 'Soup(bowl)' };
		const c = structuredClone(baseGold);
		c.items[1] = { ...c.items[1], name: 'Soup (bowl)' };
		const r = scoreCandidate(gold(g), cand(c));
		expect(r.matched).toBe(2);
		expect(r.missed_items).toEqual([]);
		expect(r.hallucinated_items).toEqual([]);
	});

	test('candidate submitting both "X (a)" and "X a" yields one match + one hallucination', () => {
		const g = structuredClone(baseGold);
		g.items[1] = { ...g.items[1], name: 'Fresh Soup (bowl)' };
		const c = structuredClone(baseGold);
		c.items = [
			c.items[0],
			{ ...c.items[1], name: 'Fresh Soup (bowl)' },
			{ ...c.items[1], name: 'Fresh Soup bowl', price: 99 }
		];
		const r = scoreCandidate(gold(g), cand(c));
		expect(r.matched).toBe(2);
		expect(r.candidate_items).toBe(3);
		expect(r.hallucinated_items).toEqual(['Fresh Soup bowl']);
		expect(r.missed_items).toEqual([]);
	});

	test('price and description null handling', () => {
		const c = structuredClone(baseGold);
		c.items[0].price = null; // gold has 14 → price miss
		c.items[1].description = 'now has text'; // gold null → description miss
		const r = scoreCandidate(gold(), cand(c));
		expect(r.price_accuracy).toBe(0.5);
		expect(r.description_accuracy).toBe(0.5);
		expect(r.price_mismatches).toEqual([{ item: 'Vegan Burger', gold: 14, candidate: null }]);
		expect(r.description_mismatches).toEqual([
			{ item: 'Fries', gold: null, candidate: 'now has text' }
		]);
		// formatSummary lists each price/description mismatch as a `! …` line
		const summary = formatSummary(r);
		expect(summary).toContain('! price differs: "Vegan Burger" gold 14 vs candidate null');
		expect(summary).toContain('! description differs: "Fries"');
		expect(summary).toContain('cand: "now has text"');

		// null === null counts correct
		const bothNull = structuredClone(baseGold);
		bothNull.items[0].price = null;
		const g = gold(structuredClone(bothNull));
		const r2 = scoreCandidate(g, cand(structuredClone(bothNull)));
		expect(r2.price_accuracy).toBe(1);
	});

	test('description matches after normalizeForSearch (case/whitespace)', () => {
		const c = structuredClone(baseGold);
		c.items[0].description = '  HOUSE   Patty ';
		const r = scoreCandidate(gold(), cand(c));
		expect(r.description_accuracy).toBe(1);
	});

	test('source URLs compared after normalizeUrl (fragment/case differences match)', () => {
		const c = structuredClone(baseGold);
		c.sources = ['https://X.com/menu#top'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.source_recall).toBe(1);
		expect(r.source_precision).toBe(1);
	});

	test('extra candidate source lowers precision but not recall', () => {
		const c = structuredClone(baseGold);
		c.sources = ['https://x.com/menu', 'https://x.com/drinks'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.source_recall).toBe(1);
		expect(r.source_precision).toBe(0.5);
		expect(r.ignored_sources).toEqual([]);
	});

	test('extra homepage root URL is ignored, not counted against precision', () => {
		const c = structuredClone(baseGold);
		c.sources = ['https://x.com/menu', 'https://x.com/'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.source_precision).toBe(1);
		expect(r.source_recall).toBe(1);
		expect(r.ignored_sources).toEqual(['https://x.com/']);

		// formatSummary annotates the ignored count on the sources line
		expect(formatSummary(r)).toContain(
			'sources    recall 100.0%  precision 100.0%  (1 root URL ignored)'
		);
	});

	test('a root URL that gold itself lists is a normal hit, not ignored', () => {
		const rootGold = structuredClone(baseGold);
		rootGold.sources = ['https://x.com/'];
		const g = gold(rootGold);
		const c = structuredClone(baseGold);
		c.sources = ['https://x.com/'];
		const r = scoreCandidate(g, cand(c));
		expect(r.source_recall).toBe(1);
		expect(r.source_precision).toBe(1);
		expect(r.ignored_sources).toEqual([]);
	});

	test('non-root extra source still drops precision', () => {
		const c = structuredClone(baseGold);
		c.sources = ['https://x.com/menu', 'https://x.com/about'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.source_precision).toBe(0.5);
		expect(r.ignored_sources).toEqual([]);
	});

	test('root URL with a query string is NOT ignored (counts as a miss)', () => {
		const c = structuredClone(baseGold);
		c.sources = ['https://x.com/menu', 'https://x.com/?page=menu'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.source_precision).toBe(0.5);
		expect(r.ignored_sources).toEqual([]);
	});

	test('no warnings anywhere: accuracy 1, lists empty', () => {
		const r = scoreCandidate(gold(), cand(structuredClone(baseGold)));
		expect(r.warning_accuracy).toBe(1);
		expect(r.missing_warnings).toEqual([]);
		expect(r.spurious_warnings).toEqual([]);
	});

	test('warning is presence-only: matching presence with different content scores 1', () => {
		const g = structuredClone(baseGold) as Record<string, unknown>;
		(g.items as Record<string, unknown>[])[0].warning = 'gold-authored note';
		const c = structuredClone(baseGold) as Record<string, unknown>;
		(c.items as Record<string, unknown>[])[0].warning = 'totally different candidate text';
		const r = scoreCandidate(gold(g), cand(c));
		expect(r.warning_accuracy).toBe(1);
		expect(r.missing_warnings).toEqual([]);
		expect(r.spurious_warnings).toEqual([]);
	});

	test('gold has a warning the candidate lacks → missing_warnings, accuracy < 1', () => {
		const g = structuredClone(baseGold) as Record<string, unknown>;
		(g.items as Record<string, unknown>[])[0].warning = 'label conflicts with ingredients';
		const r = scoreCandidate(gold(g), cand(structuredClone(baseGold)));
		expect(r.missing_warnings).toEqual(['Vegan Burger']);
		expect(r.spurious_warnings).toEqual([]);
		expect(r.warning_accuracy).toBeLessThan(1);
		expect(r.warning_accuracy).toBe(0.5);
	});

	test('candidate warns where gold does not → spurious_warnings', () => {
		const c = structuredClone(baseGold) as Record<string, unknown>;
		(c.items as Record<string, unknown>[])[0].warning = 'candidate flagged this';
		const r = scoreCandidate(gold(), cand(c));
		expect(r.spurious_warnings).toEqual(['Vegan Burger']);
		expect(r.missing_warnings).toEqual([]);
		expect(r.warning_accuracy).toBe(0.5);
	});

	test('null candidate warning where gold has a string counts as missing', () => {
		const g = structuredClone(baseGold) as Record<string, unknown>;
		(g.items as Record<string, unknown>[])[0].warning = 'gold flags it';
		const c = structuredClone(baseGold) as Record<string, unknown>;
		(c.items as Record<string, unknown>[])[0].warning = null;
		const r = scoreCandidate(gold(g), cand(c));
		expect(r.missing_warnings).toEqual(['Vegan Burger']);
		expect(r.warning_accuracy).toBe(0.5);

		// formatSummary renders the presence-only warnings line and the mismatch
		const summary = formatSummary(r);
		expect(summary).toContain('warnings');
		expect(summary).toContain('! missing warning: "Vegan Burger"');
	});
});

describe('CandidateSchema', () => {
	test('invalid candidate shape fails to parse', () => {
		expect(v.safeParse(CandidateSchema, { items: 'nope' }).success).toBe(false);
		expect(v.safeParse(CandidateSchema, { sources: ['https://x.com'], items: [] }).success).toBe(
			false
		);
	});
	test('valid candidate without policy_version parses', () => {
		const c = structuredClone(baseGold) as Record<string, unknown>;
		delete c.policy_version;
		expect(v.safeParse(CandidateSchema, c).success).toBe(true);
	});
});

// Skips on CI: bench/ is gitignored, so the gold file only exists on a developer's machine.
const goldPath = 'bench/tasks/namdharirestaurant/gold/data.json';
describe.skipIf(!existsSync(goldPath))('real gold scored against itself', () => {
	test('every ratio is 1 and every list empty', () => {
		const path = goldPath;
		const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
		const g = v.parse(GoldSchema, raw);
		const c = v.parse(CandidateSchema, raw);
		const r = scoreCandidate(g, c);
		expect(r.item_recall).toBe(1);
		expect(r.item_precision).toBe(1);
		expect(r.tag_precision).toBe(1);
		expect(r.tag_recall).toBe(1);
		expect(r.optional_tag_precision).toBe(1);
		expect(r.optional_tag_recall).toBe(1);
		expect(r.price_accuracy).toBe(1);
		expect(r.description_accuracy).toBe(1);
		expect(r.source_recall).toBe(1);
		expect(r.source_precision).toBe(1);
		expect(r.missed_items).toEqual([]);
		expect(r.hallucinated_items).toEqual([]);
		expect(r.tag_false_positives).toEqual([]);
	});
});
