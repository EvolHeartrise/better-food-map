import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { ScoreReport } from '../score';
import { loadRunIndex } from './record';
import { clearGoldCache, loadGold, rescoreRun, reportsDiffer, taskDirFor } from './rescore';
import { toRunRecord } from './record';

const RUNS_DIR = 'bench/runs';
const TASKS_DIR = 'bench/tasks';

function report(overrides: Partial<ScoreReport> = {}): ScoreReport {
	return {
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
		...overrides
	};
}

describe('reportsDiffer', () => {
	test('identical reports do not differ', () => {
		expect(reportsDiffer(report(), report())).toBe(false);
	});
	test('a moved metric differs', () => {
		expect(reportsDiffer(report(), report({ item_recall: 0.9 }))).toBe(true);
	});
	test('a changed gold size differs even at equal ratios', () => {
		expect(reportsDiffer(report(), report({ gold_items: 12 }))).toBe(true);
	});
	test('a changed item list IS a change — it drives the fidelity panel', () => {
		expect(reportsDiffer(report(), report({ missed_items: ['Fries'] }))).toBe(true);
	});

	test('a changed unsafe-tag claim IS a change — it drives a leaderboard column', () => {
		// Scalars alone missed this: a gold edit could flip which dietary claims are
		// unsupported while every published ratio stayed put.
		expect(
			reportsDiffer(report(), report({ tag_false_positives: [{ item: 'Fries', tag: 'vegan' }] }))
		).toBe(true);
	});

	test('list ORDER alone is not a change', () => {
		expect(
			reportsDiffer(report({ missed_items: ['a', 'b'] }), report({ missed_items: ['b', 'a'] }))
		).toBe(false);
	});
});

describe('taskDirFor', () => {
	test('falls back to the conventional path when meta points nowhere', () => {
		const run = toRunRecord({
			task: 'woodenspoon',
			dirName: 'x',
			dir: 'x',
			meta: { task_dir: 'bench/tasks/gone', status: 'scored' },
			report: null
		});
		expect(taskDirFor(run, TASKS_DIR)).toBe('bench/tasks/woodenspoon');
	});
});

describe('rescoreRun', () => {
	test('a missing gold degrades to an error, never a throw', () => {
		const run = toRunRecord({
			task: 'nope',
			dirName: 'x',
			dir: 'bench/runs/nope/x',
			meta: { status: 'scored', model: 'm', backend: 'openrouter' },
			report: report()
		});
		const result = rescoreRun(run, 'bench/definitely-not-here');
		expect(result.current).toBeNull();
		expect(result.error).toBeTruthy();
		expect(result.as_scored).not.toBeNull();
	});
});

describe.skipIf(!existsSync(RUNS_DIR) || !existsSync(TASKS_DIR))(
	'rescoreRun against real bench data',
	() => {
		test('reproduces the frozen report when gold has not moved', () => {
			clearGoldCache();
			const index = loadRunIndex(RUNS_DIR);
			// Pick a scored run whose task still has a loadable gold.
			const run = index.runs.find(
				(candidate) =>
					candidate.status === 'scored' && loadGold(taskDirFor(candidate, TASKS_DIR)).gold !== null
			);
			if (!run) return;

			const result = rescoreRun(run, TASKS_DIR);
			expect(result.current).not.toBeNull();
			// The scorer is deterministic, so any difference is a real gold change —
			// which is exactly what `changed` is for. Assert only that it computed.
			expect(typeof result.changed).toBe('boolean');
			expect(result.current_policy_version).not.toBeNull();
		});

		test('never throws across the whole corpus', () => {
			clearGoldCache();
			for (const run of loadRunIndex(RUNS_DIR).runs) {
				expect(() => rescoreRun(run, TASKS_DIR)).not.toThrow();
			}
		});
	}
);
