import { describe, expect, test } from 'bun:test';
import { htmlToText, lintGold, normalizeForSearch } from './lint';

const CORPUS = normalizeForSearch(
	htmlToText(
		'<html><body><h2>Menu</h2><p>Vegan   Burger</p><i>House patty &amp; aioli</i><p>Fries</p><script>var captcha_sdk = 1;</script></body></html>'
	)
);
const RECORDED = new Set(['https://x.com/menu']);

const goodGold = {
	policy_version: '2026-07-11',
	sources: ['https://x.com/menu'],
	items: [
		{
			name: 'Vegan Burger',
			description: 'House patty & aioli',
			tags: ['vegan'],
			optional_tags: [],
			price: 14
		},
		{ name: 'Fries', description: null, tags: [], optional_tags: ['vegan'], price: 6 }
	]
};

describe('htmlToText / normalizeForSearch', () => {
	test('strips markup and scripts, decodes entities, folds whitespace', () => {
		expect(CORPUS).toContain('vegan burger');
		expect(CORPUS).toContain('house patty & aioli');
		expect(CORPUS).not.toContain('captcha_sdk');
	});
});

describe('lintGold', () => {
	test('well-formed gold matching the corpus passes', () => {
		const r = lintGold(goodGold, CORPUS, RECORDED);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	test('rejects tags outside the six-dietary vocabulary (incl. course tags and hyphens)', () => {
		for (const bad of ['food', 'gluten-free', 'organic']) {
			const gold = structuredClone(goodGold);
			gold.items[0].tags = [bad];
			expect(lintGold(gold, CORPUS, RECORDED).errors.length).toBeGreaterThan(0);
		}
	});

	test('catches duplicate names, tag/optional overlap, negative price', () => {
		const gold = structuredClone(goodGold);
		gold.items[1] = { ...gold.items[0], description: null };
		expect(lintGold(gold, CORPUS, RECORDED).errors.join()).toContain('duplicate');

		const overlap = structuredClone(goodGold);
		overlap.items[0].optional_tags = ['vegan'];
		expect(lintGold(overlap, CORPUS, RECORDED).errors.join()).toContain('both tags and optional');

		const neg = structuredClone(goodGold);
		neg.items[0].price = -1;
		expect(lintGold(neg, CORPUS, RECORDED).errors.length).toBeGreaterThan(0);
	});

	test('name absent from the snapshot corpus is an error; description only a warning', () => {
		const gold = structuredClone(goodGold);
		gold.items[0].name = 'Phantom Dish';
		gold.items[1].description = 'text the site never served';
		const r = lintGold(gold, CORPUS, RECORDED);
		expect(r.errors.join()).toContain('Phantom Dish');
		expect(r.warnings.join()).toContain('not found verbatim');
	});

	test('sources must be recorded in the snapshot', () => {
		const gold = structuredClone(goodGold);
		gold.sources = ['https://x.com/menu#section', 'https://x.com/never-crawled'];
		const r = lintGold(gold, CORPUS, RECORDED);
		// fragment-only difference normalizes to a recorded URL; the other is a real miss
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain('never-crawled');
	});

	test('warning: a non-empty string or null passes; 42 or "" fails schema', () => {
		const withWarning = structuredClone(goodGold) as Record<string, unknown>;
		(withWarning.items as Record<string, unknown>[])[0].warning =
			'label says vegan but lists paneer';
		expect(lintGold(withWarning, CORPUS, RECORDED).errors).toEqual([]);

		const nullWarning = structuredClone(goodGold) as Record<string, unknown>;
		(nullWarning.items as Record<string, unknown>[])[0].warning = null;
		expect(lintGold(nullWarning, CORPUS, RECORDED).errors).toEqual([]);

		const numberWarning = structuredClone(goodGold) as Record<string, unknown>;
		(numberWarning.items as Record<string, unknown>[])[0].warning = 42;
		expect(lintGold(numberWarning, CORPUS, RECORDED).errors.length).toBeGreaterThan(0);

		const emptyWarning = structuredClone(goodGold) as Record<string, unknown>;
		(emptyWarning.items as Record<string, unknown>[])[0].warning = '';
		expect(lintGold(emptyWarning, CORPUS, RECORDED).errors.length).toBeGreaterThan(0);
	});

	test('malformed shape reports schema errors instead of crashing', () => {
		const r = lintGold({ items: 'nope' }, CORPUS, RECORDED);
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.errors[0]).toStartWith('schema:');
	});
});
