/**
 * Multi-pass harness wiring in run.ts: CLI surface, per-pass config inheritance,
 * meta provenance, and the review-effect summary.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryCovers, type BlacklistEntry } from './blacklist';
import { HARNESSES, promptShasFor } from './harness';
import { REVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompts';
import type { ScoreReport } from './score';
import { SnapshotStore } from './snapshot-store';
import {
	buildMeta,
	effortForPass,
	formatPassDelta,
	modelForPass,
	parseCli,
	reviewLabel,
	runAgent,
	runPasses,
	type ChatFn,
	type ChatResponse,
	type CliArgs,
	type PassExecutor,
	type RunResult,
	type TranscriptEvent
} from './run';
import type { BenchManifest } from './snapshot-store';

const ok = (args: string[]): CliArgs => {
	const parsed = parseCli(args);
	if ('error' in parsed) throw new Error(`expected parse to succeed: ${parsed.error}`);
	return parsed;
};

const err = (args: string[]): string => {
	const parsed = parseCli(args);
	if (!('error' in parsed)) throw new Error('expected parse to fail');
	return parsed.error;
};

const BASE = ['bench/tasks/x', '--model', 'm'];

describe('parseCli --harness', () => {
	test('defaults to single-pass', () => {
		expect(ok(BASE).harness).toBe('single-pass');
	});

	test('accepts a registered harness and rejects an unknown one', () => {
		expect(ok([...BASE, '--harness', 'two-pass']).harness).toBe('two-pass');
		expect(err([...BASE, '--harness', 'three-pass'])).toContain('unknown harness');
		expect(err([...BASE, '--harness'])).toContain('--harness requires a name');
	});

	test('the error names the available harnesses', () => {
		const message = err([...BASE, '--harness', 'nope']);
		for (const name of Object.keys(HARNESSES)) expect(message).toContain(name);
	});
});

describe('parseCli review overrides', () => {
	test('are optional on a harness that has a review pass', () => {
		const cli = ok([...BASE, '--harness', 'two-pass']);
		expect(cli.reviewModel).toBeUndefined();
		expect(cli.reviewEffort).toBeUndefined();
	});

	test('are captured when passed', () => {
		const cli = ok([
			...BASE,
			'--harness',
			'two-pass',
			'--review-model',
			'openai/gpt-5.6-luna',
			'--review-effort',
			'xhigh'
		]);
		expect(cli.reviewModel).toBe('openai/gpt-5.6-luna');
		expect(cli.reviewEffort).toBe('xhigh');
	});

	test('are REJECTED on a harness with no review pass', () => {
		// Silently ignoring them is how someone spends a sweep believing they
		// tested a reviewer that never ran.
		expect(err([...BASE, '--review-model', 'x'])).toContain(
			'requires a harness with a review pass'
		);
		expect(err([...BASE, '--harness', 'single-pass', '--review-effort', 'high'])).toContain(
			'requires a harness with a review pass'
		);
	});

	test('--review-effort is validated against the backend level set', () => {
		// `minimal` is an OpenRouter level the Claude SDK does not have.
		expect(ok([...BASE, '--harness', 'two-pass', '--review-effort', 'minimal']).reviewEffort).toBe(
			'minimal'
		);
		expect(
			err([
				'bench/tasks/x',
				'--model',
				'm',
				'--backend',
				'claude',
				'--harness',
				'two-pass',
				'--review-effort',
				'minimal'
			])
		).toContain('--review-effort must be one of');
	});

	test('flag order does not matter — backend may follow the review flags', () => {
		const cli = ok([
			'bench/tasks/x',
			'--model',
			'm',
			'--harness',
			'two-pass',
			'--review-effort',
			'high',
			'--backend',
			'claude'
		]);
		expect(cli.reviewEffort).toBe('high');
	});
});

describe('per-pass configuration', () => {
	const passes = HARNESSES['two-pass'].passes;
	const extract = passes[0];
	const review = passes[1];

	test('a review pass inherits the primary model and effort by default', () => {
		const cli = ok([...BASE, '--harness', 'two-pass', '--effort', 'high']);
		expect(modelForPass(cli, review)).toBe('m');
		expect(effortForPass(cli, review)).toBe('high');
	});

	test('a review override applies to the review pass ONLY', () => {
		const cli = ok([
			...BASE,
			'--harness',
			'two-pass',
			'--effort',
			'low',
			'--review-model',
			'strong/model',
			'--review-effort',
			'max'
		]);
		expect(modelForPass(cli, extract)).toBe('m');
		expect(effortForPass(cli, extract)).toBe('low');
		expect(modelForPass(cli, review)).toBe('strong/model');
		expect(effortForPass(cli, review)).toBe('max');
	});

	test('overriding only the model keeps the inherited effort', () => {
		const cli = ok([
			...BASE,
			'--harness',
			'two-pass',
			'--effort',
			'low',
			'--review-model',
			'strong/model'
		]);
		expect(modelForPass(cli, review)).toBe('strong/model');
		expect(effortForPass(cli, review)).toBe('low');
	});
});

describe('reviewLabel', () => {
	test('single-pass reads none', () => {
		expect(reviewLabel(ok(BASE))).toBe('none');
	});

	test('an inherited reviewer reads same', () => {
		expect(reviewLabel(ok([...BASE, '--harness', 'two-pass']))).toBe('same');
	});

	test('an override prints what it overrode to, so it never pools with self-correction', () => {
		expect(
			reviewLabel(ok([...BASE, '--harness', 'two-pass', '--review-model', 'strong/model']))
		).toBe('strong/model');
		expect(
			reviewLabel(
				ok([
					...BASE,
					'--harness',
					'two-pass',
					'--review-model',
					'strong/model',
					'--review-effort',
					'max'
				])
			)
		).toBe('strong/model@max');
	});

	test('an effort-only override still distinguishes the cell', () => {
		expect(reviewLabel(ok([...BASE, '--harness', 'two-pass', '--review-effort', 'max']))).toBe(
			'(same model)@max'
		);
	});
});

describe('buildMeta harness provenance', () => {
	const manifest: BenchManifest = {
		entryUrl: 'https://x.com/',
		pages: [],
		warnings: []
	} as unknown as BenchManifest;

	const result: RunResult = {
		status: 'scored',
		toolCalls: 1,
		submitAttempts: 1,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedPromptTokens: 0,
		cacheWriteTokens: 0
	};

	test('records the harness name and a prompt hash per pass', () => {
		const meta = buildMeta(
			ok([...BASE, '--harness', 'two-pass']),
			manifest,
			'draft',
			new Date(),
			result
		);
		expect(meta.harness).toBe('two-pass');
		expect(Object.keys(meta.prompt_sha).toSorted()).toEqual(['1-extract', '2-review']);
		expect(meta.prompt_sha).toEqual(promptShasFor(HARNESSES['two-pass']));
	});

	test('a single-pass run records one hash and null review fields', () => {
		const meta = buildMeta(ok(BASE), manifest, 'draft', new Date(), result);
		expect(meta.harness).toBe('single-pass');
		expect(Object.keys(meta.prompt_sha)).toEqual(['1-extract']);
		expect(meta.review_model).toBeNull();
		expect(meta.review_effort).toBeNull();
		expect(meta.passes).toEqual([]);
	});

	test('the prompt hash differs between the two harnesses', () => {
		const single = buildMeta(ok(BASE), manifest, 'draft', new Date(), result);
		const two = buildMeta(
			ok([...BASE, '--harness', 'two-pass']),
			manifest,
			'draft',
			new Date(),
			result
		);
		expect(single.prompt_sha['1-extract']).toBe(two.prompt_sha['1-extract']);
		expect(two.prompt_sha['2-review']).toBeDefined();
	});
});

describe('runAgent prompt injection', () => {
	/** An empty snapshot dir — these tests never fetch, they only inspect messages. */
	function emptyStore(): { store: SnapshotStore; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), 'bench-h-'));
		return {
			store: new SnapshotStore(dir),
			cleanup: () => rmSync(dir, { recursive: true, force: true })
		};
	}

	const submitStep = (): ChatResponse => ({
		choices: [
			{
				message: {
					role: 'assistant',
					content: null,
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: {
								name: 'submit_menu',
								arguments: JSON.stringify({ sources: ['https://x.com/menu'], items: [] })
							}
						}
					]
				}
			}
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
	});

	test('defaults to the extraction prompt and the plain entry-URL message', async () => {
		const { store, cleanup } = emptyStore();
		try {
			let seen: { role: string; content: unknown }[] = [];
			const chat: ChatFn = async (messages) => {
				seen = messages as typeof seen;
				return submitStep();
			};
			const transcript: TranscriptEvent[] = [];
			await runAgent({ chat, store, entryUrl: 'https://x.com/', maxToolCalls: 5, transcript });
			expect(seen[0].content).toBe(SYSTEM_PROMPT);
			expect(seen[1].content).toContain('https://x.com/');
		} finally {
			cleanup();
		}
	});

	test('uses the supplied system prompt and user message when given', async () => {
		const { store, cleanup } = emptyStore();
		try {
			let seen: { role: string; content: unknown }[] = [];
			const chat: ChatFn = async (messages) => {
				seen = messages as typeof seen;
				return submitStep();
			};
			await runAgent({
				chat,
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 5,
				transcript: [],
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				userMessage: 'REVIEW THIS DRAFT'
			});
			expect(seen[0].content).toBe(REVIEW_SYSTEM_PROMPT);
			expect(seen[1].content).toBe('REVIEW THIS DRAFT');
		} finally {
			cleanup();
		}
	});
});

describe('formatPassDelta', () => {
	const report = (over: Partial<ScoreReport> = {}): ScoreReport =>
		({
			gold_items: 10,
			candidate_items: 10,
			matched: 10,
			item_recall: 1,
			item_precision: 1,
			missed_items: [],
			hallucinated_items: [],
			tag_precision: 1,
			tag_recall: 1,
			optional_tag_precision: 1,
			optional_tag_recall: 1,
			tag_false_positives: [],
			price_accuracy: 1,
			price_mismatches: [],
			description_accuracy: 1,
			description_mismatches: [],
			warning_accuracy: 1,
			missing_warnings: [],
			spurious_warnings: [],
			source_recall: 1,
			source_precision: 1,
			ignored_sources: [],
			...over
		}) as ScoreReport;

	test('reports a gain as a signed percentage-point delta', () => {
		const out = formatPassDelta(report({ item_recall: 0.8 }), report({ item_recall: 0.9 }));
		expect(out).toContain('item recall');
		expect(out).toContain('80.0% → 90.0%');
		expect(out).toContain('(+10.0pp)');
	});

	test('reports a regression with its sign, never hidden behind a net verdict', () => {
		// A review pass routinely trades recall for precision; both directions
		// must be visible or the trade is invisible.
		const out = formatPassDelta(
			report({ item_recall: 0.8, item_precision: 1 }),
			report({ item_recall: 0.95, item_precision: 0.7 })
		);
		expect(out).toContain('(+15.0pp)');
		expect(out).toContain('(-30.0pp)');
	});

	test('says so plainly when nothing moved', () => {
		expect(formatPassDelta(report(), report())).toContain('no scored metric changed');
	});

	test('always reports item churn, even when the ratios are identical', () => {
		// Swapping one missed item for another leaves recall unchanged while
		// changing the answer — the counts are what make that visible.
		const out = formatPassDelta(
			report({ matched: 8, hallucinated_items: ['a', 'b'] }),
			report({ matched: 8, hallucinated_items: ['c'] })
		);
		expect(out).toContain('items 8 → 8 matched, 2 → 1 hallucinated');
	});
});

describe('blacklist harness scoping', () => {
	const base: BlacklistEntry = { model: 'm', reason: 'r', added: '2026-08-06' };

	test('an entry with no harness covers every harness', () => {
		// The existing verdicts are all of this shape, and they were written about
		// raw model capability, so they keep applying.
		expect(entryCovers(base, { model: 'm', backend: 'openrouter', harness: 'single-pass' })).toBe(
			true
		);
		expect(entryCovers(base, { model: 'm', backend: 'openrouter', harness: 'two-pass' })).toBe(
			true
		);
	});

	test('a harness-scoped entry covers only that harness', () => {
		const scoped: BlacklistEntry = { ...base, harness: 'single-pass' };
		expect(entryCovers(scoped, { model: 'm', backend: 'openrouter', harness: 'single-pass' })).toBe(
			true
		);
		expect(entryCovers(scoped, { model: 'm', backend: 'openrouter', harness: 'two-pass' })).toBe(
			false
		);
	});

	test('a config with no harness is treated as single-pass', () => {
		const scoped: BlacklistEntry = { ...base, harness: 'single-pass' };
		expect(entryCovers(scoped, { model: 'm', backend: 'openrouter' })).toBe(true);
		expect(
			entryCovers({ ...base, harness: 'two-pass' }, { model: 'm', backend: 'openrouter' })
		).toBe(false);
	});

	test('harness matching is case-insensitive like the other axes', () => {
		expect(
			entryCovers(
				{ ...base, harness: 'Two-Pass' },
				{ model: 'm', backend: 'openrouter', harness: 'two-pass' }
			)
		).toBe(true);
	});
});

describe('runPasses orchestration', () => {
	const harness = HARNESSES['two-pass'];

	function ctx(execute: PassExecutor) {
		const dir = mkdtempSync(join(tmpdir(), 'bench-seq-'));
		return {
			opts: {
				harness,
				cli: ok([...BASE, '--harness', 'two-pass']),
				store: new SnapshotStore(dir),
				entryUrl: 'https://x.com/',
				transcript: [] as TranscriptEvent[],
				apiKey: '',
				modelInfo: null,
				execute
			},
			cleanup: () => rmSync(dir, { recursive: true, force: true })
		};
	}

	const submitted = (name: string): RunResult => ({
		status: 'scored',
		candidate: {
			sources: ['https://x.com/menu'],
			items: [{ name, description: null, tags: [], optional_tags: [], price: 1 }]
		},
		toolCalls: 1,
		submitAttempts: 1,
		promptTokens: 10,
		completionTokens: 2,
		totalTokens: 12,
		cachedPromptTokens: 0,
		cacheWriteTokens: 0
	});

	test('threads pass 1 output into pass 2 and keeps both', async () => {
		const seen: (string | undefined)[] = [];
		const { opts, cleanup } = ctx(async ({ pass, previous }) => {
			seen.push(previous?.items[0].name);
			return submitted(pass.role === 'extract' ? 'draft' : 'corrected');
		});
		try {
			const seq = await runPasses(opts);
			// Pass 1 sees nothing; pass 2 sees pass 1's submission.
			expect(seen).toEqual([undefined, 'draft']);
			expect(seq.firstPassCandidate?.items[0].name).toBe('draft');
			expect(seq.passResults).toHaveLength(2);
			expect(seq.passMetas.map((m) => [m.index, m.role])).toEqual([
				[1, 'extract'],
				[2, 'review']
			]);
			expect(seq.threw).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test('stops WITHOUT error when a pass submits nothing', async () => {
		// A review pass has nothing to review; inventing a fallback would score a
		// different setup than the one requested.
		let calls = 0;
		const abandoned: string[] = [];
		const { opts, cleanup } = ctx(async () => {
			calls += 1;
			return {
				status: 'failed',
				failureReason: 'exceeded max tool calls',
				toolCalls: 40,
				submitAttempts: 0,
				promptTokens: 5,
				completionTokens: 1,
				totalTokens: 6,
				cachedPromptTokens: 0,
				cacheWriteTokens: 0
			} satisfies RunResult;
		});
		try {
			const seq = await runPasses({
				...opts,
				onPassAbandoned: (pass, reason) => abandoned.push(`${pass.index}:${reason}`)
			});
			expect(calls).toBe(1);
			expect(seq.passResults).toHaveLength(1);
			expect(seq.threw).toBeUndefined();
			expect(abandoned).toEqual(['1:exceeded max tool calls']);
			expect(seq.firstPassCandidate).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test('a THROWN pass is reported separately and preserves the earlier pass', async () => {
		// The distinction matters: "submitted nothing" is a model outcome, a throw
		// is an infrastructure failure — and the partial run must still be writable
		// so the transcript is not lost.
		const { opts, cleanup } = ctx(async ({ pass }) => {
			if (pass.role === 'extract') return submitted('draft');
			throw new Error('upstream 500');
		});
		try {
			const seq = await runPasses(opts);
			expect(seq.threw?.pass.index).toBe(2);
			expect(String(seq.threw?.error)).toContain('upstream 500');
			// Pass 1's work survives for the failed-run write.
			expect(seq.firstPassCandidate?.items[0].name).toBe('draft');
			expect(seq.passMetas).toHaveLength(2);
			expect(seq.passMetas[1].status).toBe('failed');
		} finally {
			cleanup();
		}
	});

	test('single-pass runs exactly one pass and records no first-pass artifact split', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-seq1-'));
		try {
			let calls = 0;
			const seq = await runPasses({
				harness: HARNESSES['single-pass'],
				cli: ok(BASE),
				store: new SnapshotStore(dir),
				entryUrl: 'https://x.com/',
				transcript: [],
				apiKey: '',
				modelInfo: null,
				execute: async () => {
					calls += 1;
					return submitted('only');
				}
			});
			expect(calls).toBe(1);
			expect(seq.passMetas).toHaveLength(1);
			expect(seq.firstPassCandidate?.items[0].name).toBe('only');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('per-pass metas carry the resolved model and effort, not the primary ones', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-seq2-'));
		try {
			const seq = await runPasses({
				harness,
				cli: ok([
					...BASE,
					'--harness',
					'two-pass',
					'--effort',
					'low',
					'--review-model',
					'strong/model',
					'--review-effort',
					'max'
				]),
				store: new SnapshotStore(dir),
				entryUrl: 'https://x.com/',
				transcript: [],
				apiKey: '',
				modelInfo: null,
				execute: async ({ pass }) => submitted(pass.role)
			});
			expect(seq.passMetas[0]).toMatchObject({ model: 'm', effort: 'low' });
			expect(seq.passMetas[1]).toMatchObject({ model: 'strong/model', effort: 'max' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
