import { describe, expect, test } from 'bun:test';
import type { ScoreReport } from '../score';
import {
	aggregateMetric,
	buildCells,
	describe as describeStat,
	dimensionValue,
	filterRuns,
	median,
	paretoFrontier,
	stdev,
	taskDiscrimination
} from './aggregate';
import { toRunRecord, type RunRecord } from './record';

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

function run(
	task: string,
	meta: Record<string, unknown> = {},
	scoreReport: ScoreReport | null = report()
): RunRecord {
	return toRunRecord({
		task,
		dirName: '2026-08-04T19:40:31.039Z-run',
		dir: `bench/runs/${task}/x`,
		meta: {
			model: 'model-a',
			backend: 'openrouter',
			status: scoreReport ? 'scored' : 'failed',
			started_at: '2026-08-04T19:40:31.039Z',
			...meta
		},
		report: scoreReport
	});
}

describe('statistics', () => {
	test('sample stdev needs at least two values', () => {
		expect(stdev([1])).toBeNull();
		expect(stdev([2, 4])).toBeCloseTo(Math.SQRT2);
	});
	test('median handles even and odd lengths', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBeNull();
	});
	test('describe reports spread and n', () => {
		const stat = describeStat([0.5, 1]);
		expect(stat.n).toBe(2);
		expect(stat.min).toBe(0.5);
		expect(stat.max).toBe(1);
		expect(stat.mean).toBeCloseTo(0.75);
	});
});

describe('aggregateMetric', () => {
	test('macro weights every task equally', () => {
		// Two runs on task A (0.0, 1.0) and one on task B (0.0). Macro = mean of
		// task means (0.5, 0.0) = 0.25; a flat mean over runs would say 0.333.
		const runs = [
			run('a', {}, report({ item_recall: 0 })),
			run('a', {}, report({ item_recall: 1 })),
			run('b', {}, report({ item_recall: 0 }))
		];
		expect(aggregateMetric(runs, 'item_recall', 'macro').mean).toBeCloseTo(0.25);
	});

	test('micro pools raw counts, so a big task carries more weight', () => {
		const runs = [
			run('a', {}, report({ gold_items: 100, matched: 50, item_recall: 0.5 })),
			run('b', {}, report({ gold_items: 10, matched: 10, item_recall: 1 }))
		];
		// 60 matched of 110 gold, not the (0.5 + 1)/2 = 0.75 macro answer.
		expect(aggregateMetric(runs, 'item_recall', 'micro').mean).toBeCloseTo(60 / 110);
		expect(aggregateMetric(runs, 'item_recall', 'macro').mean).toBeCloseTo(0.75);
	});

	test('per-pair accuracies micro-average exactly, weighted by matched', () => {
		const runs = [
			run('a', {}, report({ matched: 90, price_accuracy: 1 })),
			run('b', {}, report({ matched: 10, price_accuracy: 0 }))
		];
		const stat = aggregateMetric(runs, 'price_accuracy', 'micro');
		expect(stat.mean).toBeCloseTo(0.9);
		expect(stat.approx).toBeUndefined();
	});

	test('tag metrics are flagged approximate under micro', () => {
		// The report publishes tag ratios but not their denominators, so pooling
		// them can only be an approximation — and must say so.
		const runs = [run('a', {}, report({ tag_recall: 0.5 }))];
		expect(aggregateMetric(runs, 'tag_recall', 'micro').approx).toBe(true);
		expect(aggregateMetric(runs, 'tag_recall', 'macro').approx).toBeUndefined();
	});

	test('spread is reported from per-run values in both modes', () => {
		const runs = [
			run('a', {}, report({ item_recall: 0.5 })),
			run('a', {}, report({ item_recall: 1 }))
		];
		for (const mode of ['macro', 'micro'] as const) {
			const stat = aggregateMetric(runs, 'item_recall', mode);
			expect(stat.n).toBe(2);
			expect(stat.min).toBe(0.5);
			expect(stat.max).toBe(1);
			expect(stat.sd).not.toBeNull();
		}
	});

	test('runs without a report contribute nothing', () => {
		expect(aggregateMetric([run('a', {}, null)], 'item_recall', 'macro')).toMatchObject({
			mean: null,
			n: 0
		});
	});
});

describe('dimensionValue', () => {
	test('"no --effort passed" is distinct from a named level', () => {
		expect(dimensionValue(run('a', { effort: 'high' }), 'effort')).toBe('high');
		expect(dimensionValue(run('a', { effort_default: 'provider-default' }), 'effort')).toBe(
			'default(provider-default)'
		);
	});

	test('unpinned quantization is labelled, never blank', () => {
		expect(dimensionValue(run('a'), 'quantization')).toBe('unpinned');
		expect(dimensionValue(run('a', { quantization_requested: ['fp8'] }), 'quantization')).toBe(
			'fp8'
		);
	});
});

describe('buildCells', () => {
	test('groups by configuration and counts failures', () => {
		const runs = [
			run('a', { model: 'x', effort: 'high' }),
			run('b', { model: 'x', effort: 'high' }),
			run('a', { model: 'x', effort: 'high' }, null),
			run('a', { model: 'y', effort: 'high' })
		];
		const cells = buildCells(runs);
		expect(cells).toHaveLength(2);
		const x = cells.find((cell) => cell.dims.model === 'x');
		expect(x?.n_runs).toBe(3);
		expect(x?.n_failed).toBe(1);
		expect(x?.failure_rate).toBeCloseTo(1 / 3);
		expect(x?.tasks).toEqual(['a', 'b']);
	});

	test('runs served at different quantizations never share a cell', () => {
		// A score is model x provider x quantization; merging tiers would report a
		// number describing no real endpoint.
		const runs = [
			run('a', { model: 'x', providers: ['P'], provider_quantizations: { P: 'fp4' } }),
			run('a', { model: 'x', providers: ['P'], provider_quantizations: { P: 'fp8' } })
		];
		expect(buildCells(runs)).toHaveLength(2);
	});

	test('two gold versions of the SAME task is a policy conflict', () => {
		const runs = [
			run('a', { model: 'x', policy_version: 'draft' }),
			run('a', { model: 'x', policy_version: '2026-07-14' })
		];
		const [cell] = buildCells(runs);
		expect(cell.policy_versions).toEqual(['2026-07-14', 'draft']);
		expect(cell.policy_conflicts).toEqual([{ task: 'a', versions: ['2026-07-14', 'draft'] }]);
	});

	test('different tasks having different gold versions is NOT a conflict', () => {
		// Each task's gold carries its own policy_version, so a cell spanning the
		// whole bench naturally shows several. Flagging that would cry wolf on
		// every multi-task cell — which is every useful cell.
		const runs = [
			run('a', { model: 'x', policy_version: 'draft' }),
			run('b', { model: 'x', policy_version: '2026-07-14' })
		];
		const [cell] = buildCells(runs);
		expect(cell.policy_versions).toHaveLength(2);
		expect(cell.policy_conflicts).toEqual([]);
	});

	test('unsafe tag claims are summed across runs', () => {
		const withFp = report({
			tag_false_positives: [
				{ item: 'Fries', tag: 'gluten_free' },
				{ item: 'Dog', tag: 'nut_free' }
			]
		});
		const cells = buildCells([run('a', { model: 'x' }, withFp), run('a', { model: 'x' })]);
		expect(cells[0].unsafe_tag_claims_total).toBe(2);
	});

	test('custom dimensions regroup', () => {
		const runs = [run('a', { model: 'x' }), run('b', { model: 'x' })];
		expect(buildCells(runs, { dimensions: ['model', 'task'] })).toHaveLength(2);
		expect(buildCells(runs, { dimensions: ['model'] })).toHaveLength(1);
	});
});

describe('paretoFrontier', () => {
	test('keeps only points nothing beats on both axes', () => {
		const points = [
			{ item: 'cheap-bad', x: 1, y: 0.5 },
			{ item: 'cheap-good', x: 1, y: 0.9 },
			{ item: 'dear-good', x: 5, y: 0.95 },
			{ item: 'dear-bad', x: 5, y: 0.6 }
		];
		expect(
			paretoFrontier(points)
				.map((point) => point.item)
				.toSorted()
		).toEqual(['cheap-good', 'dear-good']);
	});

	test('exact ties are both kept — neither dominates', () => {
		const points = [
			{ item: 'a', x: 1, y: 1 },
			{ item: 'b', x: 1, y: 1 }
		];
		expect(paretoFrontier(points)).toHaveLength(2);
	});
});

describe('taskDiscrimination', () => {
	test('a task every config aces is flagged at ceiling', () => {
		const runs = [run('easy', { model: 'x' }), run('easy', { model: 'y' })];
		const [task] = taskDiscrimination(runs, 'item_recall');
		expect(task.task).toBe('easy');
		expect(task.ceiling_share).toBe(1);
		expect(task.sd).toBe(0);
	});

	test('a task that separates configs shows spread', () => {
		const runs = [
			run('hard', { model: 'x' }, report({ item_recall: 0.4 })),
			run('hard', { model: 'y' }, report({ item_recall: 0.9 }))
		];
		const [task] = taskDiscrimination(runs, 'item_recall');
		expect(task.range).toBeCloseTo(0.5);
		expect(task.ceiling_share).toBe(0);
		expect(task.n_cells).toBe(2);
	});
});

describe('filterRuns', () => {
	const runs = [
		run('a', { model: 'x', effort: 'high', policy_version: 'draft' }),
		run('b', { model: 'y', effort: 'low', policy_version: '2026-07-14' }),
		run('a', { model: 'x', effort: 'high' }, null)
	];

	test('filters compose', () => {
		expect(filterRuns(runs, { tasks: ['a'] })).toHaveLength(2);
		expect(filterRuns(runs, { models: ['y'] })).toHaveLength(1);
		expect(filterRuns(runs, { efforts: ['high'] })).toHaveLength(2);
		expect(filterRuns(runs, { policyVersions: ['draft'] })).toHaveLength(1);
	});

	test('failed runs are included by default', () => {
		expect(filterRuns(runs, {})).toHaveLength(3);
		expect(filterRuns(runs, { includeFailed: false })).toHaveLength(2);
	});

	test('date bounds are inclusive of the range', () => {
		expect(filterRuns(runs, { since: '2026-08-05T00:00:00.000Z' })).toHaveLength(0);
		expect(filterRuns(runs, { until: '2026-08-05T00:00:00.000Z' })).toHaveLength(3);
	});
});
