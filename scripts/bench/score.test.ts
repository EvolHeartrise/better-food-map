import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { GoldSchema } from './lint';
import { CandidateSchema, expandTags, scoreCandidate } from './score';

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
		expect([...expandTags(['gluten_free'])]).toEqual(['gluten_free']);
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
		c.items[0].tags = ['vegan', 'gluten_free'];
		const r = scoreCandidate(gold(), cand(c));
		expect(r.tag_false_positives).toEqual([{ item: 'Vegan Burger', tag: 'gluten_free' }]);
		expect(r.tag_precision).toBeLessThan(1);
		// recall stays perfect — nothing gold asserted was missed
		expect(r.tag_recall).toBe(1);
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

	test('price and description null handling', () => {
		const c = structuredClone(baseGold);
		c.items[0].price = null; // gold has 14 → price miss
		c.items[1].description = 'now has text'; // gold null → description miss
		const r = scoreCandidate(gold(), cand(c));
		expect(r.price_accuracy).toBe(0.5);
		expect(r.description_accuracy).toBe(0.5);

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

describe('real gold scored against itself', () => {
	test('every ratio is 1 and every list empty', () => {
		const path = 'bench/tasks/namdharirestaurant/gold/data.json';
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
