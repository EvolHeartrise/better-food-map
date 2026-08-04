import { describe, expect, test } from 'bun:test';
import { cellRow, parseArgs, runRow, toCsv } from './export';
import { buildCells } from './aggregate';
import { toRunRecord } from './record';

function run(overrides: Record<string, unknown> = {}) {
	return toRunRecord({
		task: 'woodenspoon',
		dirName: '2026-07-31T19:07:54.470Z-m',
		dir: 'x',
		meta: {
			model: 'model-a',
			backend: 'openrouter',
			status: 'scored',
			started_at: '2026-07-31T19:07:54.470Z',
			duration_ms: 1000,
			completion_tokens: 100,
			price: 0.002,
			...overrides
		},
		report: null
	});
}

describe('parseArgs', () => {
	test('defaults to runs/json/macro', () => {
		const parsed = parseArgs([]);
		expect(parsed).toMatchObject({ ok: true });
		if (parsed.ok) {
			expect(parsed.args).toMatchObject({ rows: 'runs', format: 'json', mode: 'macro' });
		}
	});

	test('accepts every documented flag', () => {
		const parsed = parseArgs([
			'--rows',
			'cells',
			'--format',
			'csv',
			'--mode',
			'micro',
			'--runs-dir',
			'tmp/runs',
			'--out',
			'out.csv'
		]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args).toEqual({
				rows: 'cells',
				format: 'csv',
				mode: 'micro',
				runsDir: 'tmp/runs',
				out: 'out.csv'
			});
		}
	});

	test('rejects bad values and unknown flags', () => {
		expect(parseArgs(['--rows', 'wat']).ok).toBe(false);
		expect(parseArgs(['--format', 'yaml']).ok).toBe(false);
		expect(parseArgs(['--mode', 'mean']).ok).toBe(false);
		expect(parseArgs(['--nope']).ok).toBe(false);
		expect(parseArgs(['--out']).ok).toBe(false);
	});
});

describe('runRow', () => {
	test('flattens scalars and derived values', () => {
		const row = runRow(run());
		expect(row.run_id).toBe('woodenspoon/2026-07-31T19:07:54.470Z-m');
		expect(row.cost_usd).toBe(0.002);
		expect(row.output_tok_per_s).toBeCloseTo(100);
		expect(row.provenance).toBe('provider unknown · unpinned');
	});

	test('unknown values stay null so a CSV cell is empty, not zero', () => {
		const row = runRow(run({ price: null }));
		expect(row.cost_usd).toBeNull();
		expect(row.wall_clock_ms).toBeNull();
	});
});

describe('cellRow', () => {
	test('every mean is accompanied by its n', () => {
		const [cell] = buildCells([run(), run()]);
		const row = cellRow(cell);
		expect(row.n_runs).toBe(2);
		expect(row).toHaveProperty('item_recall_mean');
		expect(row).toHaveProperty('item_recall_n');
	});
});

describe('toCsv', () => {
	test('empty input yields empty output', () => {
		expect(toCsv([])).toBe('');
	});

	test('quotes separators, newlines and quotes', () => {
		const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'line\nbreak' }]);
		expect(csv).toBe('a,b,c\n"x,y","say ""hi""","line\nbreak"');
	});

	test('null renders as an empty cell', () => {
		expect(toCsv([{ a: 1, b: null }])).toBe('a,b\n1,');
	});

	test('columns are the union across rows, so optional flags survive', () => {
		const csv = toCsv([{ a: 1 }, { a: 2, approx: 1 }]);
		expect(csv.split('\n')[0]).toBe('a,approx');
		expect(csv.split('\n')[1]).toBe('1,');
	});
});
