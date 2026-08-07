import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	blockFor,
	hideBlacklisted,
	loadBlacklistSafe,
	modelStates,
	runConfig,
	runsCoveredBy,
	scopeCoverage,
	statusFor,
	toInfo,
	type Blacklist,
	type BlacklistEntry
} from './blacklist';
import type { RunRecord } from './record';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		run_id: 'task/run',
		task: 'task',
		dir: 'bench/runs/task/run',
		model: 'openai/gpt-5.6-luna',
		backend: 'openrouter',
		effort: 'high',
		effort_default: null,
		temperature: null,
		quantization_requested: null,
		providers: null,
		provider_quantizations: null,
		harness: 'single-pass',
		prompt_sha: null,
		review_model: null,
		review_effort: null,
		passes: [],
		policy_version: 'draft',
		entry_url: null,
		task_dir: null,
		status: 'scored',
		failure_reason: null,
		started_at: '2026-08-01T00:00:00.000Z',
		invoked_at: null,
		duration_ms: 1000,
		wall_clock_ms: null,
		tool_calls: 5,
		submit_attempts: 1,
		prompt_tokens: 10,
		completion_tokens: 10,
		total_tokens: 20,
		cached_prompt_tokens: 0,
		cache_write_tokens: 0,
		price: null,
		price_cached: null,
		total_cost_usd: null,
		report: null,
		report_pass1: null,
		...overrides
	};
}

function list(...entries: Blacklist['entries']): Blacklist {
	return { entries };
}

const REASON = 'ruled out by the 2026-07-31 sweep';

describe('runConfig', () => {
	test('a null effort becomes undefined, not the string "null"', () => {
		// The distinction the `default` scope turns on: `effort: null` in meta.json
		// means no --effort was passed, which the blacklist spells `undefined`.
		expect(runConfig(run({ effort: null })).effort).toBeUndefined();
		expect(runConfig(run({ effort: 'xhigh' })).effort).toBe('xhigh');
	});
});

describe('blockFor', () => {
	test('an entry with no effort covers every level, default included', () => {
		const bl = list({ model: 'openai/gpt-5.6-luna', reason: REASON, added: '2026-07-31' });
		expect(blockFor(run({ effort: 'high' }), bl)).not.toBeNull();
		expect(blockFor(run({ effort: null }), bl)).not.toBeNull();
	});

	test('`default` and `none` are DIFFERENT scopes', () => {
		// Blacklisting "the provider default" must not block an explicit
		// `--effort none`, and vice versa — they are separate configurations.
		const onDefault = list({
			model: 'openai/gpt-5.6-luna',
			effort: 'default',
			reason: REASON,
			added: '2026-07-31'
		});
		expect(blockFor(run({ effort: null }), onDefault)).not.toBeNull();
		expect(blockFor(run({ effort: 'none' }), onDefault)).toBeNull();

		const onNone = list({
			model: 'openai/gpt-5.6-luna',
			effort: 'none',
			reason: REASON,
			added: '2026-07-31'
		});
		expect(blockFor(run({ effort: 'none' }), onNone)).not.toBeNull();
		expect(blockFor(run({ effort: null }), onNone)).toBeNull();
	});

	test('backend narrows the scope; an omitted backend covers both', () => {
		const claudeOnly = list({
			model: 'openai/gpt-5.6-luna',
			backend: 'claude',
			reason: REASON,
			added: '2026-07-31'
		});
		expect(blockFor(run({ backend: 'openrouter' }), claudeOnly)).toBeNull();
		expect(blockFor(run({ backend: 'claude' }), claudeOnly)).not.toBeNull();
	});

	test('model matching is case-insensitive, as on the CLI', () => {
		const bl = list({ model: 'OpenAI/GPT-5.6-Luna', reason: REASON, added: '2026-07-31' });
		expect(blockFor(run(), bl)).not.toBeNull();
	});

	test('an empty blacklist blocks nothing', () => {
		expect(blockFor(run(), list())).toBeNull();
	});
});

describe('statusFor', () => {
	const bl = list({
		model: 'openai/gpt-5.6-luna',
		effort: 'none',
		reason: REASON,
		added: '2026-07-31'
	});

	test('none / partial / all are three distinct answers', () => {
		expect(statusFor([run({ effort: 'high' })], bl).state).toBe('none');
		expect(statusFor([run({ effort: 'none' })], bl).state).toBe('all');
		// A grouping that spans efforts (e.g. ?dims=model) really can be partial,
		// and collapsing it either way would retire live configs or hide dead ones.
		expect(statusFor([run({ effort: 'none' }), run({ effort: 'high' })], bl).state).toBe('partial');
	});

	test('counts travel with the state, so a partial can be sized', () => {
		const status = statusFor([run({ effort: 'none' }), run({ effort: 'high' })], bl);
		expect(status.n_blocked).toBe(1);
		expect(status.n_runs).toBe(2);
	});

	test('an empty group is `none`, never `all`', () => {
		// `blocked === runs.length` is trivially true for an empty group; reporting
		// that as "all retired" would badge every empty cell in the UI.
		expect(statusFor([], bl)).toEqual({ state: 'none', n_blocked: 0, n_runs: 0, entries: [] });
	});

	test('one entry covering many runs is reported once', () => {
		const status = statusFor([run({ effort: 'none' }), run({ effort: 'none' })], bl);
		expect(status.entries).toHaveLength(1);
		expect(status.n_blocked).toBe(2);
	});
});

describe('hideBlacklisted', () => {
	test('drops only covered runs and preserves order', () => {
		const bl = list({
			model: 'openai/gpt-5.6-luna',
			effort: 'none',
			reason: REASON,
			added: '2026-07-31'
		});
		const runs = [
			run({ run_id: 'a', effort: 'high' }),
			run({ run_id: 'b', effort: 'none' }),
			run({ run_id: 'c', effort: 'max' })
		];
		expect(hideBlacklisted(runs, bl).map((entry) => entry.run_id)).toEqual(['a', 'c']);
	});

	test('an empty blacklist is a pass-through copy, not the same array', () => {
		const runs = [run()];
		const out = hideBlacklisted(runs, list());
		expect(out).toEqual(runs);
		expect(out).not.toBe(runs);
	});
});

describe('modelStates', () => {
	test('reports all/partial per model and omits clean ones', () => {
		const bl = list(
			{ model: 'a/one', reason: REASON, added: '2026-07-31' },
			{ model: 'a/two', effort: 'none', reason: REASON, added: '2026-07-31' }
		);
		const states = modelStates(
			[
				run({ model: 'a/one', effort: 'high' }),
				run({ model: 'a/two', effort: 'none' }),
				run({ model: 'a/two', effort: 'high' }),
				run({ model: 'a/three', effort: 'high' })
			],
			bl
		);
		expect(states).toEqual({ 'a/one': 'all', 'a/two': 'partial' });
	});
});

describe('toInfo', () => {
	test('an omitted or `*` effort both render as the `all` scope', () => {
		const base = { model: 'm', reason: REASON, added: '2026-07-31' };
		expect(toInfo(base).effort).toBe('all');
		expect(toInfo({ ...base, effort: '*' }).effort).toBe('all');
		expect(toInfo({ ...base, effort: 'none' }).effort).toBe('none');
	});

	test('absent optional fields become null, never empty strings', () => {
		const info = toInfo({ model: 'm', reason: REASON, added: '2026-07-31' });
		expect(info.backend).toBeNull();
		expect(info.evidence).toBeNull();
	});

	test('coverage is null without a corpus and a real count with one', () => {
		// Null is UNKNOWN. 0 is a live verdict that happens to hide nothing today —
		// a different fact, and the UI badges only the second.
		const entry = { model: 'a/one', effort: 'max', reason: REASON, added: '2026-07-31' };
		expect(toInfo(entry).n_runs_covered).toBeNull();
		expect(toInfo(entry, []).n_runs_covered).toBe(0);
		expect(
			toInfo(entry, [run({ model: 'a/one', effort: 'max' }), run({ model: 'a/one' })])
				.n_runs_covered
		).toBe(1);
	});
});

describe('runsCoveredBy', () => {
	test('counts what the ENTRY covers, not what the model has', () => {
		// The bug this exists to prevent: a verdict on grok@max was badged "no runs
		// in the corpus" because the model-level map only lists BLOCKED models, so
		// ten grok runs at other levels left no key behind.
		const runs = [
			run({ model: 'x-ai/grok-4.5', effort: 'high' }),
			run({ model: 'x-ai/grok-4.5', effort: 'low' })
		];
		const atMax = { model: 'x-ai/grok-4.5', effort: 'max', reason: REASON, added: '2026-07-31' };
		expect(runsCoveredBy(runs, atMax)).toBe(0);
		expect(modelStates(runs, list(atMax))['x-ai/grok-4.5']).toBeUndefined();

		const allLevels = { model: 'x-ai/grok-4.5', reason: REASON, added: '2026-07-31' };
		expect(runsCoveredBy(runs, allLevels)).toBe(2);
	});
});

describe('scopeCoverage', () => {
	test('reports every leaderboard row a scope would retire, not just one', () => {
		// The blacklist has no provenance axis but the leaderboard splits on it, so
		// one verdict can retire two rows. The form shows this before recording.
		const runs = [
			run({ effort: 'high', quantization_requested: ['fp8'], providers: ['GMICloud'] }),
			run({ effort: 'high', quantization_requested: null, providers: null, task: 'other' })
		];
		const coverage = scopeCoverage(runs, { model: 'openai/gpt-5.6-luna', effort: 'high' });
		expect(coverage.n_runs).toBe(2);
		expect(coverage.n_configs).toBe(2);
		expect(coverage.tasks).toEqual(['other', 'task']);
	});

	test('a scope covering one row reports exactly one config', () => {
		const coverage = scopeCoverage([run({ effort: 'high' })], {
			model: 'openai/gpt-5.6-luna',
			effort: 'high'
		});
		expect(coverage.n_configs).toBe(1);
	});

	test('a scope matching nothing is zero across the board, never a throw', () => {
		expect(scopeCoverage([run()], { model: 'nobody/here' })).toEqual({
			n_runs: 0,
			n_configs: 0,
			configs: [],
			tasks: []
		});
	});
});

describe('loadBlacklistSafe', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bench-blacklist-'));

	test('a missing file is an empty blacklist, not an error', () => {
		const result = loadBlacklistSafe(join(dir, 'absent.json'));
		expect(result.list.entries).toEqual([]);
		expect(result.error).toBeNull();
	});

	test('a malformed file CARRIES its error instead of throwing or lying', () => {
		// The CLI throws here on purpose (a corrupt blacklist must not re-enable
		// spending). A read-only viewer has no spend to protect, but it must not
		// answer "nothing is blacklisted" either — so the error travels and the UI
		// reports the file as unreadable.
		const path = join(dir, 'broken.json');
		writeFileSync(path, '{ not json');
		const result = loadBlacklistSafe(path);
		expect(result.list.entries).toEqual([]);
		expect(result.error).toContain('not valid JSON');
	});

	test('a schema-invalid file is an error too, not a silent partial read', () => {
		const path = join(dir, 'invalid.json');
		writeFileSync(path, JSON.stringify({ entries: [{ model: 'm', reason: 'r', added: 'nope' }] }));
		expect(loadBlacklistSafe(path).error).toContain('added must be YYYY-MM-DD');
	});
});

describe('harness scope reaches the analytics layer', () => {
	// The matcher defaults a missing `cfg.harness` to `single-pass`, so a
	// `runConfig` that dropped the field evaluated EVERY run as single-pass —
	// inverting the verdict in both directions at once.
	// Same model the `run()` fixture uses, so only the harness axis is in play.
	const MODEL = 'openai/gpt-5.6-luna';
	const entry = (harness?: string): BlacklistEntry => ({
		model: MODEL,
		harness,
		reason: 'r',
		added: '2026-08-06'
	});

	test('a single-pass verdict does NOT retire a two-pass run', () => {
		// This is the README's recommended re-test workflow: scope the old verdicts
		// to single-pass, then run the model under a new harness. Before the fix the
		// runner allowed those runs and the leaderboard hid them.
		const twoPass = run({ harness: 'two-pass' });
		expect(blockFor(twoPass, { entries: [entry('single-pass')] })).toBeNull();
		expect(runsCoveredBy([twoPass], entry('single-pass'))).toBe(0);
		expect(hideBlacklisted([twoPass], { entries: [entry('single-pass')] })).toHaveLength(1);
	});

	test('a two-pass verdict DOES retire a two-pass run', () => {
		const twoPass = run({ harness: 'two-pass' });
		expect(blockFor(twoPass, { entries: [entry('two-pass')] })).not.toBeNull();
		expect(runsCoveredBy([twoPass], entry('two-pass'))).toBe(1);
	});

	test('a two-pass verdict leaves single-pass runs alone', () => {
		const single = run({ harness: 'single-pass' });
		expect(blockFor(single, { entries: [entry('two-pass')] })).toBeNull();
	});

	test('an unscoped verdict still covers every harness', () => {
		// Every pre-existing verdict is this shape and must keep applying.
		for (const harness of ['single-pass', 'two-pass']) {
			expect(blockFor(run({ harness }), { entries: [entry()] })).not.toBeNull();
		}
	});

	test('toInfo surfaces the scope so the register can show it', () => {
		expect(toInfo(entry('single-pass')).harness).toBe('single-pass');
		expect(toInfo(entry()).harness).toBeNull();
	});
});
