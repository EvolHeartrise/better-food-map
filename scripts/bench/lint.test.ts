import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToText, lintGold, lintTask, normalizeForSearch, stripVariantSuffix } from './lint';

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

	test('preserves img alt text as [image: …], drops other attributes', () => {
		const text = htmlToText(
			'<img src="Vegan-Burger-300x300.jpg" srcset="Vegan-Burger-1024.jpg 1024w" ' +
				'alt="Vegan Battered Cauliflower with Tamarind Chili Glaze"/>' +
				'<img alt=\'Fish &amp; Chips\' src="x.jpg">' +
				'<img alt="" src="decorative.jpg"><img src="no-alt.jpg">' +
				'<a title="Vegan Menu" href="/menu">Menu</a>'
		);
		expect(text).toContain('[image: Vegan Battered Cauliflower with Tamarind Chili Glaze]');
		expect(text).toContain('[image: Fish & Chips]');
		expect(text).not.toContain('300x300'); // filenames/srcset stay stripped
		expect(text).not.toContain('decorative');
		expect(text).not.toContain('Vegan Menu'); // non-img attributes stay stripped
	});
});

describe('htmlToText entity decoding', () => {
	test('decodes the named set, preserving case on accented letters', () => {
		expect(htmlToText('caf&eacute;')).toBe('café');
		expect(htmlToText('&Eacute;clair')).toBe('Éclair');
		expect(htmlToText('jalape&ntilde;o')).toBe('jalapeño');
		expect(htmlToText('NYF&reg;')).toBe('NYF®');
		expect(htmlToText('soup &ndash; salad')).toBe('soup – salad');
		expect(htmlToText('Flamin&rsquo; Bacon')).toBe('Flamin’ Bacon');
	});

	test('an uppercase spelling of a case-independent entity still decodes', () => {
		expect(htmlToText('5 &AMP; 6')).toBe('5 & 6');
		expect(htmlToText('&QUOT;x&QUOT;')).toBe('"x"');
	});

	test('decodes decimal, zero-padded decimal, and hex numeric forms', () => {
		expect(htmlToText('Flamin&#8217; Bacon')).toBe('Flamin’ Bacon');
		expect(htmlToText('Flamin&#x2019; Bacon')).toBe('Flamin’ Bacon');
		expect(htmlToText('Flamin&#X2019; Bacon')).toBe('Flamin’ Bacon');
		// Zero-padded forms the old 7-entry table missed entirely.
		expect(htmlToText('it&#039;s 5 &#038; 6')).toBe("it's 5 & 6");
	});

	test('an unknown entity is left INTACT, never replaced with a space', () => {
		// The regression this whole change exists for: replacing an unrecognized
		// entity with a space deleted the character AND the word boundary, so
		// "caf&eacute;" read as "caf" and no gold name containing it could match.
		expect(htmlToText('I &hearts; poutine')).toBe('I &hearts; poutine');
		expect(htmlToText('a&thinsp;b')).toBe('a&thinsp;b');
	});

	test('code points that are not text are left intact rather than injected', () => {
		expect(htmlToText('a&#0;b')).toBe('a&#0;b'); // NUL
		expect(htmlToText('a&#xD800;b')).toBe('a&#xD800;b'); // lone surrogate
		expect(htmlToText('a&#1114112;b')).toBe('a&#1114112;b'); // > U+10FFFF
	});

	test('a bare ampersand and a non-entity are untouched', () => {
		expect(htmlToText('Fish & Chips')).toBe('Fish & Chips');
		expect(htmlToText('a & b; c')).toBe('a & b; c');
	});
});

describe('normalizeForSearch Unicode normalization', () => {
	// Written as explicit code points, never as source literals: the two forms are
	// indistinguishable on screen, so a literal pair would depend on how an editor
	// happened to save this file rather than on what the function does.
	const NFD = 'saut\u0065\u0301ed onions'; // e + combining acute — MeeT's snapshot
	const NFC = 'saut\u00e9ed onions'; // precomposed é — the hand-authored gold

	test('NFD and NFC spellings of the same word compare equal', () => {
		expect(NFD).not.toBe(NFC); // identical on screen, different strings
		expect(normalizeForSearch(NFD)).toBe(normalizeForSearch(NFC));
	});

	test('a decomposed corpus still contains a composed gold description', () => {
		const corpus = normalizeForSearch(htmlToText(`<p>with ${NFD}</p>`));
		expect(corpus).toContain(normalizeForSearch(NFC));
	});

	test('normalization does not merge genuinely different letters', () => {
		expect(normalizeForSearch('resume')).not.toBe(normalizeForSearch('r\u00e9sum\u00e9'));
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

describe('stripVariantSuffix', () => {
	test('strips one trailing parenthetical to a non-empty base', () => {
		expect(stripVariantSuffix('Fresh Soup! (bowl)')).toBe('Fresh Soup!');
		expect(stripVariantSuffix('Sortie du Chai BC VQA (5 oz)')).toBe('Sortie du Chai BC VQA');
	});
	test('strips only the LAST group ("X (a) (b)" → "X (a)")', () => {
		expect(stripVariantSuffix('X (a) (b)')).toBe('X (a)');
	});
	test('a mid-string parenthetical is not a trailing group', () => {
		expect(stripVariantSuffix('Aloo kachori (Punjabi Style) 1pc')).toBeUndefined();
	});
	test('a name with no parenthetical, or one that is ONLY a parenthetical, returns undefined', () => {
		expect(stripVariantSuffix('Fries')).toBeUndefined();
		expect(stripVariantSuffix('(bowl)')).toBeUndefined();
	});
});

describe('lintGold variant names', () => {
	// Corpus carries the bare dish names and a mid-string parenthetical, but NOT
	// the variant labels themselves (a source may itemize an unlabeled default).
	const VARIANT_CORPUS = normalizeForSearch(
		htmlToText('<p>Fresh Soup!</p><p>Aloo kachori (Punjabi Style) 1pc</p><p>Nested X (a)</p>')
	);
	const REC = new Set(['https://x.com/menu']);
	const base = {
		policy_version: '2026-07-11',
		sources: ['https://x.com/menu'],
		items: [{ name: 'PLACEHOLDER', description: null, tags: [], optional_tags: [], price: 1 }]
	};
	const withName = (name: string): typeof base => {
		const g = structuredClone(base);
		g.items[0].name = name;
		return g;
	};

	test('variant name passes when only its base is in the corpus', () => {
		expect(lintGold(withName('Fresh Soup! (bowl)'), VARIANT_CORPUS, REC).errors).toEqual([]);
	});
	test('a plain rewritten name (no base in corpus) still fails', () => {
		const r = lintGold(withName('Creamy Tomato Bisque (bowl)'), VARIANT_CORPUS, REC);
		expect(r.errors.join()).toContain('not found');
	});
	test('a mid-parenthetical name found verbatim in full passes via the full-name path', () => {
		expect(
			lintGold(withName('Aloo kachori (Punjabi Style) 1pc'), VARIANT_CORPUS, REC).errors
		).toEqual([]);
	});
	test('stripping applies only once — "Nested X (a) (b)" passes on base "Nested X (a)"', () => {
		expect(lintGold(withName('Nested X (a) (b)'), VARIANT_CORPUS, REC).errors).toEqual([]);
	});
	test('a name that is ONLY a parenthetical (empty base) fails', () => {
		const r = lintGold(withName('(bowl)'), VARIANT_CORPUS, REC);
		expect(r.errors.join()).toContain('not found');
	});

	test('a format disambiguator passes on its base, and both spellings coexist', () => {
		// New York Fries lists a poutine AND a hot dog as "Bacon Double Cheese".
		// Gold names must be unique, so the format is an authored qualifier in a
		// trailing group — which the base-stripping rule already accepts. Written
		// as a bare suffix ("… Dog") it is neither verbatim nor marked as authored,
		// which is exactly how three real gold items read as typos.
		const corpus = normalizeForSearch(htmlToText('<p>Bacon Double Cheese</p>'));
		const gold = structuredClone(base);
		gold.items = [
			{ name: 'Bacon Double Cheese', description: null, tags: [], optional_tags: [], price: 9 },
			{
				name: 'Bacon Double Cheese (Dog)',
				description: null,
				tags: [],
				optional_tags: [],
				price: 8
			}
		];
		const r = lintGold(gold, corpus, REC);
		expect(r.errors).toEqual([]); // unique names, both resolve to the same verbatim base

		const bare = structuredClone(gold);
		bare.items[1].name = 'Bacon Double Cheese Dog';
		expect(lintGold(bare, corpus, REC).errors.join()).toContain('not found');
	});
});

describe('lintTask: a task with nothing to lint yet', () => {
	function withTask(fn: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), 'bench-lint-'));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test('a scaffolded task with no gold is SKIPPED, not failed', () => {
		withTask((dir) => {
			// What `bench:new <slug> <url> --stratum …` leaves behind.
			writeFileSync(join(dir, 'task.json'), '{"slug":"x"}');
			const r = lintTask(dir);
			expect(r.errors).toEqual([]);
			expect(r.skipped).toBe('no gold authored yet');
		});
	});

	test('a drafted-but-unpromoted task names the draft in its skip reason', () => {
		withTask((dir) => {
			// What `bench:draft` leaves behind: draft.json, deliberately not data.json.
			mkdirSync(join(dir, 'gold'), { recursive: true });
			writeFileSync(join(dir, 'gold', 'draft.json'), '{}');
			const r = lintTask(dir);
			expect(r.errors).toEqual([]);
			expect(r.skipped).toContain('draft.json');
		});
	});

	test('gold present but no manifest is a real error, never a skip', () => {
		withTask((dir) => {
			mkdirSync(join(dir, 'gold'), { recursive: true });
			writeFileSync(join(dir, 'gold', 'data.json'), JSON.stringify(goodGold));
			const r = lintTask(dir);
			expect(r.skipped).toBeUndefined();
			expect(r.errors.join()).toContain('manifest');
		});
	});

	test('unparseable gold is an error, not a skip', () => {
		withTask((dir) => {
			mkdirSync(join(dir, 'gold'), { recursive: true });
			writeFileSync(join(dir, 'gold', 'data.json'), '{ not json');
			const r = lintTask(dir);
			expect(r.skipped).toBeUndefined();
			expect(r.errors.length).toBeGreaterThan(0);
		});
	});
});
