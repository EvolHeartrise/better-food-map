import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_HARNESS,
	HARNESSES,
	HARNESS_NAMES,
	harnessFor,
	isHarnessName,
	mergePassResults,
	promptShaLabel,
	promptShasFor,
	userMessageFor,
	type PassSpec
} from './harness';
import { REVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT, promptSha } from './prompts';
import type { CandidateMenu } from './score';
import type { RunResult } from './run';

const candidate = (name: string): CandidateMenu => ({
	sources: ['https://x.com/menu'],
	items: [{ name, description: null, tags: [], optional_tags: [], price: 1 }]
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
	status: 'scored',
	toolCalls: 1,
	submitAttempts: 1,
	promptTokens: 100,
	completionTokens: 10,
	totalTokens: 110,
	cachedPromptTokens: 0,
	cacheWriteTokens: 0,
	...over
});

describe('registry', () => {
	test('single-pass is the default and has exactly one extract pass', () => {
		expect(DEFAULT_HARNESS).toBe('single-pass');
		const spec = harnessFor('single-pass');
		expect(spec?.passes).toHaveLength(1);
		expect(spec?.passes[0]).toMatchObject({ index: 1, role: 'extract' });
		expect(spec?.passes[0].systemPrompt).toBe(SYSTEM_PROMPT);
	});

	test('two-pass extracts then reviews, in that order', () => {
		const spec = harnessFor('two-pass');
		expect(spec?.passes.map((p) => [p.index, p.role])).toEqual([
			[1, 'extract'],
			[2, 'review']
		]);
		expect(spec?.passes[1].systemPrompt).toBe(REVIEW_SYSTEM_PROMPT);
	});

	test('every registered harness starts with an extract pass and numbers passes from 1', () => {
		// A review pass has nothing to review without a preceding submission, and
		// `userMessageFor` throws on one. This is the structural guard.
		for (const name of HARNESS_NAMES) {
			const spec = HARNESSES[name];
			expect(spec.passes[0].role).toBe('extract');
			expect(spec.passes.map((p) => p.index)).toEqual(spec.passes.map((_, i) => i + 1));
			expect(spec.name).toBe(name);
		}
	});

	test('unknown names are rejected', () => {
		expect(isHarnessName('two-pass')).toBe(true);
		expect(isHarnessName('three-pass')).toBe(false);
		expect(harnessFor('nope')).toBeUndefined();
	});
});

describe('REVIEW_SYSTEM_PROMPT', () => {
	test('embeds the extraction rules verbatim', () => {
		// A reviewer working from a different rule set rewrites correct
		// conventions into plausible wrongness; composing is what prevents that.
		expect(REVIEW_SYSTEM_PROMPT).toContain(SYSTEM_PROMPT);
	});

	test('tells the reviewer to resubmit the whole menu, not a diff', () => {
		expect(REVIEW_SYSTEM_PROMPT).toContain('COMPLETE corrected menu');
	});

	test('never tells the model it is being graded', () => {
		// The reviewer must behave as if this were production work. Naming a score,
		// a benchmark or ground truth would both change its behaviour and hint that
		// an authority beyond the source exists.
		//
		// "answer key" is deliberately NOT banned: the prompt uses it in a negation
		// ("treat it as a draft ... never as an answer key"), which is the opposite
		// of a leak. Banning the substring would fail on correct text, so the real
		// guard is the user-message test below — that is the surface where run data
		// could actually reach the model.
		for (const banned of ['gold', 'ground truth', 'benchmark', 'score']) {
			expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).not.toContain(banned);
		}
	});
});

describe('userMessageFor', () => {
	const extract: PassSpec = { index: 1, role: 'extract', systemPrompt: 'x' };
	const review: PassSpec = { index: 2, role: 'review', systemPrompt: 'y' };

	test('an extract pass gets only the entry URL', () => {
		const msg = userMessageFor(extract, 'https://x.com/', undefined);
		expect(msg).toContain('https://x.com/');
		expect(msg).not.toContain('previous agent');
	});

	test('a review pass gets the entry URL and the previous submission', () => {
		const msg = userMessageFor(review, 'https://x.com/', candidate('Poutine'));
		expect(msg).toContain('https://x.com/');
		expect(msg).toContain('Poutine');
		expect(msg).toContain('https://x.com/menu');
	});

	test('a review pass hands over items and sources but not policy_version', () => {
		const withPolicy: CandidateMenu = { ...candidate('Fries'), policy_version: '2026-07-11' };
		const msg = userMessageFor(review, 'https://x.com/', withPolicy);
		expect(msg).toContain('Fries');
		expect(msg).not.toContain('2026-07-11');
		expect(msg).not.toContain('policy_version');
	});

	test('a review pass with no previous candidate is a programming error', () => {
		expect(() => userMessageFor(review, 'https://x.com/', undefined)).toThrow(
			/no previous candidate/
		);
	});

	test('the review message carries ONLY the entry URL and the draft, nothing else', () => {
		// This is the surface where answer-key data could actually reach a model:
		// the system prompt is static and eyeballable, this string is built at run
		// time. Extra keys hung off the candidate object must not be serialized —
		// a future caller passing an enriched object must not silently widen what
		// the model sees.
		const enriched = {
			...candidate('Poutine'),
			policy_version: '2026-07-11',
			// Shapes a careless caller might attach; none may survive.
			report: { item_recall: 0.5 },
			gold: { items: [{ name: 'SECRET GOLD ITEM' }] }
		} as CandidateMenu;
		const msg = userMessageFor(review, 'https://x.com/', enriched);

		expect(msg).toContain('Poutine');
		expect(msg).not.toContain('SECRET GOLD ITEM');
		expect(msg).not.toContain('item_recall');
		expect(msg).not.toContain('2026-07-11');

		// And structurally: the JSON payload has exactly two keys.
		const json = msg.slice(msg.indexOf('{'));
		expect(Object.keys(JSON.parse(json)).toSorted()).toEqual(['items', 'sources']);
	});
});

describe('promptSha', () => {
	test('is deterministic and 12 hex chars', () => {
		expect(promptSha('abc')).toBe(promptSha('abc'));
		expect(promptSha('abc')).toMatch(/^[0-9a-f]{12}$/);
	});

	test('changes on any edit, including whitespace', () => {
		// The point is detecting that the prompt CHANGED, not judging whether the
		// change mattered — so a trailing space must produce a different hash.
		expect(promptSha('abc')).not.toBe(promptSha('abd'));
		expect(promptSha('abc')).not.toBe(promptSha('abc '));
	});
});

describe('promptShasFor / promptShaLabel', () => {
	test('keys by index and role, so a repeated role never collapses', () => {
		const shas = promptShasFor({
			name: 'x',
			description: '',
			passes: [
				{ index: 1, role: 'extract', systemPrompt: 'a' },
				{ index: 2, role: 'review', systemPrompt: 'b' },
				{ index: 3, role: 'review', systemPrompt: 'c' }
			]
		});
		expect(Object.keys(shas).toSorted()).toEqual(['1-extract', '2-review', '3-review']);
		expect(new Set(Object.values(shas)).size).toBe(3);
	});

	test('two-pass and single-pass produce different labels', () => {
		const single = promptShaLabel(promptShasFor(HARNESSES['single-pass']));
		const two = promptShaLabel(promptShasFor(HARNESSES['two-pass']));
		expect(single).not.toBe(two);
		expect(single.split('/')).toHaveLength(1);
		expect(two.split('/')).toHaveLength(2);
	});

	test('an absent hash reads as unknown, never as a match', () => {
		// A run predating prompt hashing must not pool with one whose prompt is
		// recorded — nothing establishes that they agree.
		expect(promptShaLabel(null)).toBe('unknown');
		expect(promptShaLabel(undefined)).toBe('unknown');
		expect(promptShaLabel({})).toBe('unknown');
	});
});

describe('mergePassResults', () => {
	test('sums every count across passes', () => {
		const merged = mergePassResults([
			result({ toolCalls: 3, promptTokens: 100, completionTokens: 10, totalTokens: 110 }),
			result({ toolCalls: 5, promptTokens: 400, completionTokens: 20, totalTokens: 420 })
		]);
		expect(merged.toolCalls).toBe(8);
		expect(merged.promptTokens).toBe(500);
		expect(merged.completionTokens).toBe(30);
		expect(merged.totalTokens).toBe(530);
	});

	test('the surviving candidate is the LAST pass to produce one', () => {
		const merged = mergePassResults([
			result({ candidate: candidate('draft') }),
			result({ candidate: candidate('corrected') })
		]);
		expect(merged.candidate?.items[0].name).toBe('corrected');
	});

	test('a failed final pass fails the run even when an earlier pass submitted', () => {
		// The setup being measured is the pair, not its better half.
		const merged = mergePassResults([
			result({ candidate: candidate('draft') }),
			result({ status: 'failed', failureReason: 'exceeded max tool calls', candidate: undefined })
		]);
		expect(merged.status).toBe('failed');
		expect(merged.candidate).toBeUndefined();
		expect(merged.failureReason).toBe('exceeded max tool calls');
	});

	test('providers are unioned in first-seen order without duplicates', () => {
		const merged = mergePassResults([
			result({ providers: ['DeepInfra', 'GMICloud'] }),
			result({ providers: ['GMICloud', 'Together'] })
		]);
		expect(merged.providers).toEqual(['DeepInfra', 'GMICloud', 'Together']);
	});

	test('cost sums when reported and stays ABSENT when no pass reported any', () => {
		// 0 would claim the run was free, which is a different fact from "unknown".
		expect(mergePassResults([result(), result()]).totalCostUsd).toBeUndefined();
		expect(
			mergePassResults([result({ totalCostUsd: 0.01 }), result({ totalCostUsd: 0.02 })])
				.totalCostUsd
		).toBeCloseTo(0.03, 10);
	});

	test('usages concatenate in pass order so cost accounting sees every request', () => {
		const merged = mergePassResults([
			result({ usages: [{ prompt_tokens: 1 }] }),
			result({ usages: [{ prompt_tokens: 2 }, { prompt_tokens: 3 }] })
		]);
		expect(merged.usages?.map((u) => u.prompt_tokens)).toEqual([1, 2, 3]);
	});

	test('merging nothing is a programming error, not an empty run', () => {
		expect(() => mergePassResults([])).toThrow(/no passes/);
	});
});
