import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	addEntry,
	describeEntry,
	entryCovers,
	findBlock,
	formatBlocked,
	formatList,
	loadBlacklist,
	parseCli,
	removeEntries,
	saveBlacklist,
	today,
	type Blacklist,
	type BlacklistEntry
} from './blacklist';

const entry = (over: Partial<BlacklistEntry> = {}): BlacklistEntry => ({
	model: 'openai/gpt-5.6-luna',
	effort: 'none',
	reason: 'tag recall collapses without reasoning',
	added: '2026-07-31',
	...over
});

function withTmp(fn: (path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'bench-blacklist-'));
	try {
		fn(join(dir, 'blacklist.json'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('entryCovers', () => {
	const cfg = { model: 'openai/gpt-5.6-luna', effort: 'none', backend: 'openrouter' };

	test('matches the exact model + effort', () => {
		expect(entryCovers(entry(), cfg)).toBe(true);
	});

	test('a different effort or model is not covered', () => {
		expect(entryCovers(entry(), { ...cfg, effort: 'xhigh' })).toBe(false);
		expect(entryCovers(entry(), { ...cfg, model: 'openai/gpt-5.6-luna-pro' })).toBe(false);
	});

	test('model matching ignores case and surrounding whitespace', () => {
		expect(entryCovers(entry({ model: '  OpenAI/GPT-5.6-Luna ' }), cfg)).toBe(true);
	});

	test('an omitted effort covers every level INCLUDING the default', () => {
		const all = entry({ effort: undefined });
		expect(entryCovers(all, cfg)).toBe(true);
		expect(entryCovers(all, { ...cfg, effort: 'max' })).toBe(true);
		expect(entryCovers(all, { ...cfg, effort: undefined })).toBe(true);
	});

	test("effort '*' behaves the same as omitting it", () => {
		expect(entryCovers(entry({ effort: '*' }), { ...cfg, effort: 'max' })).toBe(true);
	});

	test("effort 'default' covers ONLY a run that passed no --effort", () => {
		const def = entry({ effort: 'default' });
		expect(entryCovers(def, { ...cfg, effort: undefined })).toBe(true);
		// 'none' is an explicit level, NOT the provider default — must not match.
		expect(entryCovers(def, { ...cfg, effort: 'none' })).toBe(false);
	});

	test('an omitted backend covers both; a set one is exact', () => {
		expect(entryCovers(entry(), { ...cfg, backend: 'claude' })).toBe(true);
		const orOnly = entry({ backend: 'openrouter' });
		expect(entryCovers(orOnly, cfg)).toBe(true);
		expect(entryCovers(orOnly, { ...cfg, backend: 'claude' })).toBe(false);
	});
});

describe('findBlock', () => {
	test('returns the first covering entry, or undefined when allowed', () => {
		const list: Blacklist = { entries: [entry(), entry({ effort: 'low' })] };
		expect(
			findBlock(list, { model: 'openai/gpt-5.6-luna', effort: 'low', backend: 'openrouter' })
		).toEqual(entry({ effort: 'low' }));
		expect(
			findBlock(list, { model: 'openai/gpt-5.6-luna', effort: 'xhigh', backend: 'openrouter' })
		).toBeUndefined();
	});

	test('an empty blacklist blocks nothing', () => {
		expect(findBlock({ entries: [] }, { model: 'any', backend: 'openrouter' })).toBeUndefined();
	});
});

describe('loadBlacklist / saveBlacklist', () => {
	test('a missing file is an empty blacklist, not an error', () => {
		withTmp((path) => {
			expect(loadBlacklist(path)).toEqual({ entries: [] });
		});
	});

	test('round-trips through disk', () => {
		withTmp((path) => {
			saveBlacklist({ entries: [entry()] }, path);
			expect(loadBlacklist(path)).toEqual({ entries: [entry()] });
		});
	});

	test('malformed JSON throws rather than silently allowing spend', () => {
		withTmp((path) => {
			writeFileSync(path, '{ not json');
			expect(() => loadBlacklist(path)).toThrow(/not valid JSON/);
		});
	});

	test('a schema-invalid entry throws (a reason and a date are required)', () => {
		withTmp((path) => {
			writeFileSync(path, JSON.stringify({ entries: [{ model: 'm' }] }));
			expect(() => loadBlacklist(path)).toThrow(/invalid/);
			writeFileSync(path, JSON.stringify({ entries: [{ ...entry(), added: '31-07-2026' }] }));
			expect(() => loadBlacklist(path)).toThrow(/YYYY-MM-DD/);
		});
	});

	test('the write is atomic and leaves no temp file behind', () => {
		// A plain writeFileSync truncates first, so a crash mid-write leaves a
		// half-file — and loadBlacklist treats a malformed file as a HARD ERROR, so
		// that window turns a crash into "every bench:run refuses to start" plus the
		// loss of every verdict in the file. rename() closes it.
		withTmp((path) => {
			saveBlacklist({ entries: [entry()] }, path);
			saveBlacklist({ entries: [entry(), entry({ model: 'second/model' })] }, path);
			expect(loadBlacklist(path).entries).toHaveLength(2);
			expect(existsSync(`${path}.tmp`)).toBe(false);
		});
	});

	test('overwriting never leaves a partially-written file readable', () => {
		withTmp((path) => {
			saveBlacklist({ entries: [entry()] }, path);
			// Whatever is at `path` after any save must parse — the invariant rename
			// buys us, checked here so a future switch back to writeFileSync fails.
			for (let n = 2; n <= 6; n += 1) {
				const entries = Array.from({ length: n }, (_, i) => entry({ model: `m/${i}` }));
				saveBlacklist({ entries }, path);
				expect(loadBlacklist(path).entries).toHaveLength(n);
			}
		});
	});
});

describe('addEntry / removeEntries', () => {
	test('adds an entry and refuses an exact-scope duplicate', () => {
		const first = addEntry({ entries: [] }, entry());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.list.entries).toHaveLength(1);

		const dup = addEntry(first.list, entry({ reason: 'different words, same scope' }));
		expect(dup.ok).toBe(false);
		if (dup.ok) return;
		expect(dup.error).toContain('already blacklisted');
	});

	test('the same model at a different effort is a distinct scope', () => {
		const first = addEntry({ entries: [] }, entry());
		if (!first.ok) throw new Error('setup');
		const second = addEntry(first.list, entry({ effort: 'low' }));
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.list.entries).toHaveLength(2);
	});

	test('removes only the matching scope', () => {
		const list: Blacklist = { entries: [entry(), entry({ effort: 'low' })] };
		const { list: next, removed } = removeEntries(list, {
			model: 'openai/gpt-5.6-luna',
			effort: 'low'
		});
		expect(removed).toHaveLength(1);
		expect(next.entries).toEqual([entry()]);
	});

	test('removing a scope that is not listed reports nothing removed', () => {
		const { removed } = removeEntries({ entries: [entry()] }, { model: 'nope' });
		expect(removed).toHaveLength(0);
	});
});

describe('formatting', () => {
	test('describeEntry names the scope, spelling out an all-effort entry', () => {
		expect(describeEntry(entry())).toBe('openai/gpt-5.6-luna [effort: none]');
		expect(describeEntry(entry({ effort: undefined }))).toBe('openai/gpt-5.6-luna [effort: all]');
		expect(describeEntry(entry({ backend: 'claude' }))).toContain('backend: claude');
	});

	test('formatBlocked carries the reason, the date, and both escape hatches', () => {
		const msg = formatBlocked(entry({ evidence: 'bench/runs/x' }), '--ignore-blacklist');
		expect(msg).toContain('is blacklisted');
		expect(msg).toContain('tag recall collapses without reasoning');
		expect(msg).toContain('2026-07-31');
		expect(msg).toContain('bench/runs/x');
		expect(msg).toContain('--ignore-blacklist');
		expect(msg).toContain('bench:blacklist --remove --model openai/gpt-5.6-luna --effort none');
	});

	test('an empty list says so rather than printing a bare header', () => {
		expect(formatList({ entries: [] })).toContain('empty');
	});
});

describe('parseCli', () => {
	test('defaults to list mode', () => {
		expect(parseCli([])).toEqual({ mode: 'list' });
		expect(parseCli(['--list'])).toEqual({ mode: 'list' });
	});

	test('parses an add with every field', () => {
		expect(
			parseCli([
				'--add',
				'--model',
				'm',
				'--effort',
				'none',
				'--backend',
				'claude',
				'--reason',
				'r',
				'--evidence',
				'e'
			])
		).toEqual({
			mode: 'add',
			model: 'm',
			effort: 'none',
			backend: 'claude',
			reason: 'r',
			evidence: 'e'
		});
	});

	test('--add without a reason is refused (a verdict needs its why)', () => {
		expect(parseCli(['--add', '--model', 'm'])).toEqual({
			error: '--reason is required with --add (a verdict without a reason is unusable)'
		});
	});

	test('every non-list mode requires --model', () => {
		expect(parseCli(['--remove'])).toEqual({ error: '--model is required with --remove' });
		expect(parseCli(['--check'])).toEqual({ error: '--model is required with --check' });
	});

	test('rejects two modes, an unknown flag, a valueless flag, and a bad backend', () => {
		expect(parseCli(['--add', '--remove'])).toEqual({
			error: 'pass exactly one of --add / --remove / --check'
		});
		expect(parseCli(['--nope'])).toEqual({ error: 'unknown option: --nope' });
		expect(parseCli(['--model'])).toEqual({ error: '--model requires a value' });
		expect(parseCli(['--check', '--model', 'm', '--backend', 'vertex'])).toEqual({
			error: '--backend must be openrouter|claude (got vertex)'
		});
	});
});

describe('today', () => {
	test('formats as YYYY-MM-DD in UTC', () => {
		expect(today(new Date('2026-07-31T23:59:00Z'))).toBe('2026-07-31');
	});
});
