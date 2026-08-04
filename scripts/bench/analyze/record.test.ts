import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { loadRunIndex, timestampFromDirName, toRunRecord } from './record';

const RUNS_DIR = 'bench/runs';

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: 'openai/gpt-5.6-luna',
		backend: 'openrouter',
		task_dir: 'bench/tasks/woodenspoon',
		entry_url: 'https://example.com/',
		effort: 'high',
		effort_default: 'provider-default',
		temperature: null,
		policy_version: '2026-07-14',
		started_at: '2026-07-31T19:07:54.470Z',
		duration_ms: 1000,
		tool_calls: 5,
		submit_attempts: 1,
		prompt_tokens: 100,
		completion_tokens: 50,
		total_tokens: 150,
		cached_prompt_tokens: 40,
		cache_write_tokens: 0,
		price: 0.001,
		price_cached: 0.0009,
		status: 'scored',
		...overrides
	};
}

function record(overrides: Record<string, unknown> = {}) {
	return toRunRecord({
		task: 'woodenspoon',
		dirName: '2026-07-31T19:07:54.470Z-openai-gpt-5.6-luna',
		dir: 'bench/runs/woodenspoon/2026-07-31T19:07:54.470Z-openai-gpt-5.6-luna',
		meta: meta(overrides),
		report: null
	});
}

describe('toRunRecord', () => {
	test('flattens a meta into a typed row', () => {
		const run = record();
		expect(run.run_id).toBe('woodenspoon/2026-07-31T19:07:54.470Z-openai-gpt-5.6-luna');
		expect(run.task).toBe('woodenspoon');
		expect(run.model).toBe('openai/gpt-5.6-luna');
		expect(run.effort).toBe('high');
		expect(run.status).toBe('scored');
		expect(run.price).toBe(0.001);
	});

	test('ABSENT optional fields read as null, never 0', () => {
		// The corpus really is like this: 128/156 runs predate provenance logging
		// and 10 predate wall_clock_ms. Reading those as 0 would invent facts.
		const run = record();
		expect(run.wall_clock_ms).toBeNull();
		expect(run.invoked_at).toBeNull();
		expect(run.providers).toBeNull();
		expect(run.provider_quantizations).toBeNull();
		expect(run.quantization_requested).toBeNull();
	});

	test('an empty providers array is preserved as distinct from absent', () => {
		expect(record({ providers: [] }).providers).toEqual([]);
		expect(record({}).providers).toBeNull();
	});

	test('a null-valued number field reads as unknown', () => {
		expect(record({ price: null }).price).toBeNull();
		expect(record({ temperature: null }).temperature).toBeNull();
	});

	test('wrong-typed fields degrade to unknown rather than coercing', () => {
		const run = record({ duration_ms: 'fast', providers: 'DeepInfra' });
		expect(run.duration_ms).toBeNull();
		expect(run.providers).toBeNull();
	});

	test('failed runs keep their reason and a null report', () => {
		const run = record({ status: 'failed', failure_reason: 'TimeoutError' });
		expect(run.status).toBe('failed');
		expect(run.failure_reason).toBe('TimeoutError');
		expect(run.report).toBeNull();
	});

	test('started_at falls back to the run directory timestamp', () => {
		const run = toRunRecord({
			task: 'woodenspoon',
			dirName: '2026-08-04T19:40:31.039Z-deepseek-deepseek-v4-flash-0731',
			dir: 'x',
			meta: { model: 'm', backend: 'openrouter', status: 'scored' },
			report: null
		});
		expect(run.started_at).toBe('2026-08-04T19:40:31.039Z');
	});

	test('unknown model/backend get explicit labels, not empty strings', () => {
		const run = toRunRecord({
			task: 't',
			dirName: 'nope',
			dir: 'x',
			meta: {},
			report: null
		});
		expect(run.model).toBe('(unknown model)');
		expect(run.backend).toBe('(unknown backend)');
		expect(run.started_at).toBe('');
	});
});

describe('timestampFromDirName', () => {
	test('recovers the ISO prefix', () => {
		expect(timestampFromDirName('2026-08-04T19:40:31.039Z-deepseek-v4')).toBe(
			'2026-08-04T19:40:31.039Z'
		);
	});
	test('returns null when there is no timestamp prefix', () => {
		expect(timestampFromDirName('grok-4.5')).toBeNull();
	});
});

describe('loadRunIndex', () => {
	test('a missing runs dir yields an empty index, never a throw', () => {
		// bench/ is gitignored, so CI and fresh clones legitimately have no runs.
		const index = loadRunIndex('bench/definitely-not-here');
		expect(index.runs).toEqual([]);
		expect(index.problems).toEqual([]);
	});
});

describe.skipIf(!existsSync(RUNS_DIR))('loadRunIndex against real bench data', () => {
	test('indexes every run dir with no problems', () => {
		const index = loadRunIndex(RUNS_DIR);
		expect(index.runs.length).toBeGreaterThan(0);
		expect(index.problems).toEqual([]);
	});

	test('run ids are unique and sorted newest first', () => {
		const index = loadRunIndex(RUNS_DIR);
		expect(new Set(index.runs.map((run) => run.run_id)).size).toBe(index.runs.length);
		const stamps = index.runs.map((run) => run.started_at);
		expect(stamps.toSorted((a, b) => b.localeCompare(a))).toEqual(stamps);
	});

	test('scored runs carry a report; failed runs do not', () => {
		for (const run of loadRunIndex(RUNS_DIR).runs) {
			if (run.status === 'scored') expect(run.report).not.toBeNull();
			else expect(run.failure_reason).not.toBeNull();
		}
	});
});
