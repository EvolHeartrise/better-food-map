/**
 * Wire-shape contract for the harness/prompt-provenance fields.
 *
 * `RunRow` in `types.ts` hand-mirrors what `runRow()` emits, and nothing makes
 * the compiler check a mirror against the thing it reflects — that is exactly
 * how the `menu_*` drift crashed the navigation tab on every run (see
 * `coverage-contract.test.ts`). `runRow()` returns
 * `Record<string, string | number | null>`, so importing its type would say
 * nothing about field NAMES; these tests assert the names and kinds instead.
 *
 * The absent-vs-default distinction is the substance here. `harness` legitimately
 * defaults (a run predating the field WAS single-pass), while `prompt_sha` must
 * NOT (a run predating prompt hashing has an unknown prompt, not a matching one).
 * Getting those two backwards would silently pool runs that share no prompt.
 */
import { describe, expect, test } from 'bun:test';
import { runRow } from '../../../scripts/bench/analyze/export';
import { toRunRecord } from '../../../scripts/bench/analyze/record';
import type { RunRow } from './types';

/** A run indexed from a meta.json with whatever fields the caller supplies. */
function row(meta: Record<string, unknown>): Record<string, string | number | null> {
	return runRow(
		toRunRecord({
			task: 't',
			dirName: '2026-08-06T00:00:00.000Z-m',
			dir: 'bench/runs/t/x',
			meta: { model: 'm', backend: 'openrouter', status: 'scored', ...meta },
			report: null
		})
	);
}

describe('harness wire contract', () => {
	test('every harness field the UI reads is emitted', () => {
		const emitted = row({ harness: 'two-pass' });
		for (const key of ['harness', 'review', 'prompt_sha', 'n_passes'] satisfies (keyof RunRow)[]) {
			expect(emitted).toHaveProperty(key);
		}
	});

	test('a pre-harness run reads single-pass — a fact, not a placeholder', () => {
		// Those 156 runs genuinely had one pass; it was the only setup that existed.
		const emitted = row({});
		expect(emitted.harness).toBe('single-pass');
		expect(emitted.review).toBe('none');
		// NULL, not 0. Those runs each made exactly one pass; `0` would be a false
		// statement, and it is the same absent-vs-zero trap `prompt_sha` avoids.
		expect(emitted.n_passes).toBeNull();
	});

	test('a pre-hashing run reads UNKNOWN prompt, never a match', () => {
		// The dangerous direction: defaulting this to today's hash would pool runs
		// across a prompt edit and report a number describing neither prompt.
		expect(row({}).prompt_sha).toBe('unknown');
		expect(row({ prompt_sha: {} }).prompt_sha).toBe('unknown');
	});

	test('recorded hashes are joined in pass order', () => {
		expect(row({ prompt_sha: { '1-extract': 'aaa', '2-review': 'bbb' } }).prompt_sha).toBe(
			'aaa/bbb'
		);
	});

	test('review reads `same` when the reviewer inherited, and the override otherwise', () => {
		expect(row({ harness: 'two-pass', passes: [{ index: 2, role: 'review' }] }).review).toBe(
			'same'
		);
		expect(row({ harness: 'two-pass', review_model: 'strong/model' }).review).toBe('strong/model');
		expect(
			row({ harness: 'two-pass', review_model: 'strong/model', review_effort: 'max' }).review
		).toBe('strong/model@max');
	});

	test('pass-1 and delta columns are null on a single-pass run, not zero', () => {
		// Zero would read as "the reviewer changed nothing", which is a different
		// fact from "there was no reviewer".
		const emitted = row({});
		expect(emitted.pass1_item_recall).toBeNull();
		expect(emitted.review_delta_item_recall).toBeNull();
	});

	test('the delta is final minus pass-1, signed', () => {
		const emitted = runRow(
			toRunRecord({
				task: 't',
				dirName: '2026-08-06T00:00:00.000Z-m',
				dir: 'bench/runs/t/x',
				meta: { model: 'm', backend: 'openrouter', status: 'scored', harness: 'two-pass' },
				report: { item_recall: 0.9, item_precision: 0.5 } as never,
				reportPass1: { item_recall: 0.8, item_precision: 0.7 } as never
			})
		);
		expect(emitted.pass1_item_recall).toBeCloseTo(0.8, 10);
		expect(emitted.review_delta_item_recall).toBeCloseTo(0.1, 10);
		// A regression keeps its sign — the trade must stay visible.
		expect(emitted.review_delta_item_precision).toBeCloseTo(-0.2, 10);
	});
});
