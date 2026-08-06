import { describe, expect, test } from 'bun:test';
import { nameMatchKey } from '../../../scripts/bench/score';
import {
	configKey,
	diffRuns,
	frontierKeys,
	heatLookup,
	heatRows,
	itemKey,
	plottableCells
} from './analysis';
import type { CellRow, MenuItem, MetricKey, Stat } from './types';

function stat(mean: number | null): Stat {
	return { mean, sd: null, median: mean, min: mean, max: mean, n: mean === null ? 0 : 1 };
}

function cell(overrides: Partial<CellRow> = {}): CellRow {
	const metrics = Object.fromEntries(
		(
			[
				'item_recall',
				'item_precision',
				'tag_precision',
				'tag_recall',
				'optional_tag_precision',
				'optional_tag_recall',
				'price_accuracy',
				'description_accuracy',
				'warning_accuracy',
				'source_recall',
				'source_precision'
			] as MetricKey[]
		).map((key) => [key, stat(1)])
	) as Record<MetricKey, Stat>;

	return {
		key: 'k',
		model: 'm',
		backend: 'openrouter',
		effort: 'high',
		quantization: 'unpinned',
		provenance: 'provider unknown · unpinned',
		n_runs: 1,
		n_scored: 1,
		n_failed: 0,
		failure_rate: 0,
		tasks: 't',
		n_tasks: 1,
		scored_tasks: 't',
		n_scored_tasks: 1,
		unattributed_runs: 0,
		policy_versions: 'draft',
		policy_conflict_tasks: '',
		policy_conflicts: [],
		provenances: [],
		mixed_provenance: 0,
		rerouted: 0,
		unsafe_tag_claims_total: 0,
		run_ids: [],
		blacklist: { state: 'none', n_blocked: 0, n_runs: 1, entries: [] },
		metrics,
		stats: {
			cost_usd: stat(0.01),
			price_cached: stat(0.01),
			duration_ms: stat(1000),
			total_tokens: stat(100),
			cache_hit_rate: stat(0.5),
			output_tok_per_s: stat(10),
			unsafe_tag_claims: stat(0)
		},
		...overrides
	};
}

function item(overrides: Partial<MenuItem> = {}): MenuItem {
	return { name: 'Fries', description: null, tags: [], optional_tags: [], price: 5, ...overrides };
}

describe('itemKey mirrors the scorer', () => {
	test('agrees with nameMatchKey on adversarial names', () => {
		// A divergence here would surface "differences" in Compare that the scorer
		// never counted, so this is checked against the real implementation.
		const names = [
			'Fresh Soup (Bowl)',
			'Fresh Soup Bowl',
			'Soup(bowl)',
			"Flamin' Bacon Dog",
			'Flamin’ Bacon Dog',
			'Stone Road Red (5 oz glass) (Happy Hour)',
			'  spaced   out  ',
			'Nested ((inner)) name',
			'Unbalanced ( paren',
			'Unbalanced ) paren',
			'',
			'((()))',
			'MIXED Case Name',
			'tabs\tand\nnewlines'
		];
		for (const name of names) {
			expect(itemKey(name)).toBe(nameMatchKey(name));
		}
	});
});

describe('plottableCells', () => {
	test('drops a cell missing either axis rather than plotting it at zero', () => {
		const cells = [
			cell({ key: 'ok' }),
			cell({ key: 'no-cost', stats: { ...cell().stats, cost_usd: stat(null) } }),
			cell({ key: 'no-score', metrics: { ...cell().metrics, item_recall: stat(null) } })
		];
		const plotted = plottableCells(cells, (c) => c.stats.cost_usd.mean, 'item_recall');
		expect(plotted.map((entry) => entry.cell.key)).toEqual(['ok']);
	});

	test('a zero-cost cell is excluded from a log axis rather than skewing it', () => {
		const cells = [cell({ key: 'free', stats: { ...cell().stats, cost_usd: stat(0) } })];
		expect(plottableCells(cells, (c) => c.stats.cost_usd.mean, 'item_recall')).toEqual([]);
	});
});

describe('frontierKeys', () => {
	test('keeps only points nothing beats on both axes', () => {
		const points = [
			{ cell: cell({ key: 'cheap-bad' }), x: 1, y: 0.5 },
			{ cell: cell({ key: 'cheap-good' }), x: 1, y: 0.9 },
			{ cell: cell({ key: 'dear-good' }), x: 5, y: 0.95 },
			{ cell: cell({ key: 'dear-bad' }), x: 5, y: 0.6 }
		];
		expect([...frontierKeys(points)].toSorted()).toEqual(['cheap-good', 'dear-good']);
	});

	test('exact ties are both kept — neither dominates', () => {
		const points = [
			{ cell: cell({ key: 'a' }), x: 1, y: 1 },
			{ cell: cell({ key: 'b' }), x: 1, y: 1 }
		];
		expect(frontierKeys(points).size).toBe(2);
	});

	test('a single point is its own frontier; empty input yields nothing', () => {
		expect(frontierKeys([{ cell: cell({ key: 'solo' }), x: 2, y: 0.3 }]).size).toBe(1);
		expect(frontierKeys([]).size).toBe(0);
	});
});

describe('heatmap grouping', () => {
	test('provenance splits rows, matching the leaderboard rule', () => {
		const a = cell({ provenance: 'A@fp8 · pinned:fp8' });
		const b = cell({ provenance: 'B@fp4 · unpinned' });
		expect(configKey(a)).not.toBe(configKey(b));
		expect(heatRows([a, b])).toHaveLength(2);
	});

	test('rows differing only by backend are distinguishable', () => {
		const rows = heatRows([cell({ backend: 'openrouter' }), cell({ backend: 'claude' })]);
		expect(rows).toHaveLength(2);
		expect(rows[0].note).not.toBe(rows[1].note);
	});

	test('a blacklisted configuration is marked in the row LABEL, not the note', () => {
		// The note only renders when some dimension varies across the grid, so a
		// marker living there would vanish in a single-backend, single-provenance
		// slice — exactly the common case.
		const rows = heatRows([
			cell({
				model: 'openai/gpt-5.6-luna',
				blacklist: {
					state: 'all',
					n_blocked: 1,
					n_runs: 1,
					entries: [
						{
							model: 'openai/gpt-5.6-luna',
							effort: 'none',
							backend: null,
							reason: 'tag recall collapses',
							added: '2026-07-31',
							evidence: null,
							label: 'openai/gpt-5.6-luna [effort: none]',
							n_runs_covered: 1
						}
					]
				}
			})
		]);
		expect(rows[0].label.startsWith('⊘ ')).toBe(true);
		expect(rows[0].note).toBeUndefined();
	});

	test('a live configuration carries no marker', () => {
		expect(heatRows([cell()])[0].label.startsWith('⊘')).toBe(false);
	});

	test('a cell that ran but scored nothing is distinct from one that never ran', () => {
		const failed = cell({
			task: 'woodenspoon',
			n_runs: 1,
			n_scored: 0,
			n_failed: 1,
			metrics: { ...cell().metrics, item_recall: stat(null) }
		});
		const lookup = heatLookup([failed], 'item_recall');
		const found = lookup.get(`${configKey(failed)}::woodenspoon`);
		expect(found).toEqual({ value: null, n: 1, failed: 1 });
		// A task the config never touched has no entry at all.
		expect(lookup.get(`${configKey(failed)}::meetonmain`)).toBeUndefined();
	});
});

describe('diffRuns', () => {
	test('splits items by presence and marks gold membership', () => {
		const diff = diffRuns(
			[item({ name: 'Fries' }), item({ name: 'Poutine' })],
			[item({ name: 'Fries' })],
			[item({ name: 'Poutine' })]
		);
		expect(diff.onlyA.map((entry) => entry.name)).toEqual(['Poutine']);
		expect(diff.onlyB).toEqual([]);
		expect(diff.goldKeys.has(itemKey('Poutine'))).toBe(true);
	});

	test('matching is paren-insensitive, exactly like the scorer', () => {
		const diff = diffRuns(
			[item({ name: 'Fresh Soup (Bowl)' })],
			[item({ name: 'Fresh Soup Bowl' })],
			null
		);
		expect(diff.onlyA).toEqual([]);
		expect(diff.onlyB).toEqual([]);
	});

	test('every scored field is compared, not just price and tags', () => {
		// The heading claims exhaustiveness; a diff that skipped description showed
		// "0 differences" for runs whose description accuracy differed by 14 points.
		const diff = diffRuns(
			[item({ price: 5, tags: ['vegan'], optional_tags: [], description: 'a', warning: 'w' })],
			[item({ price: 6, tags: [], optional_tags: ['vegan'], description: 'b', warning: null })],
			null
		);
		expect(diff.differing.map((entry) => entry.field).toSorted()).toEqual([
			'description',
			'optional_tags',
			'price',
			'tags',
			'warning'
		]);
	});

	test('identical items produce no differences', () => {
		const one = item({ description: 'same', tags: ['vegan'] });
		expect(diffRuns([one], [{ ...one }], null).differing).toEqual([]);
	});

	test('description comparison is whitespace- and case-insensitive, like the scorer', () => {
		const diff = diffRuns(
			[item({ description: 'House  Patty' })],
			[item({ description: 'house patty' })],
			null
		);
		expect(diff.differing).toEqual([]);
	});
});
