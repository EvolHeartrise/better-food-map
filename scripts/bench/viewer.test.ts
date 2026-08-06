import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
	filterFromQuery,
	includeBlacklistedFromQuery,
	parseArgs,
	parseDimensions,
	parseMetric,
	parseMode,
	parseScope,
	resolveAsset,
	writeRefusal
} from './viewer';
import { DEFAULT_DIMENSIONS } from './analyze/aggregate';
import { BLACKLIST_PATH } from './analyze/blacklist';

describe('parseArgs', () => {
	test('defaults', () => {
		const parsed = parseArgs([]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args).toEqual({
				port: 8792,
				runsDir: 'bench/runs',
				tasksDir: 'bench/tasks',
				blacklistPath: BLACKLIST_PATH,
				readOnly: false,
				rebuild: false,
				build: true
			});
		}
	});

	test('accepts each flag', () => {
		const parsed = parseArgs([
			'--port',
			'9000',
			'--runs-dir',
			'a',
			'--tasks-dir',
			'b',
			'--blacklist',
			'c.json',
			'--read-only',
			'--rebuild',
			'--no-build'
		]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args).toEqual({
				port: 9000,
				runsDir: 'a',
				tasksDir: 'b',
				blacklistPath: 'c.json',
				readOnly: true,
				rebuild: true,
				build: false
			});
		}
	});

	test('rejects bad ports and unknown flags', () => {
		expect(parseArgs(['--port', 'http']).ok).toBe(false);
		expect(parseArgs(['--port', '0']).ok).toBe(false);
		expect(parseArgs(['--port', '70000']).ok).toBe(false);
		expect(parseArgs(['--wat']).ok).toBe(false);
		expect(parseArgs(['--blacklist']).ok).toBe(false);
	});
});

describe('query parsing', () => {
	test('mode and metric fall back rather than erroring', () => {
		expect(parseMode('micro')).toBe('micro');
		expect(parseMode('nonsense')).toBe('macro');
		expect(parseMetric('tag_recall')).toBe('tag_recall');
		expect(parseMetric('made_up')).toBe('item_recall');
	});

	test('unknown dimensions are dropped, and an all-unknown list falls back', () => {
		expect(parseDimensions('model,task')).toEqual(['model', 'task']);
		expect(parseDimensions('model,wat')).toEqual(['model']);
		expect(parseDimensions('wat,nope')).toEqual(DEFAULT_DIMENSIONS);
		expect(parseDimensions(null)).toEqual(DEFAULT_DIMENSIONS);
	});

	test('repeated params build a list filter', () => {
		const filter = filterFromQuery(new URL('http://x/api/cells?task=a&task=b&model=m'));
		expect(filter.tasks).toEqual(['a', 'b']);
		expect(filter.models).toEqual(['m']);
		expect(filter.includeFailed).toBe(true);
	});

	test('failed runs are only excluded when explicitly asked', () => {
		expect(filterFromQuery(new URL('http://x/api/runs?include_failed=0')).includeFailed).toBe(
			false
		);
		expect(filterFromQuery(new URL('http://x/api/runs')).includeFailed).toBe(true);
	});

	test('blacklisted configs are hidden unless explicitly included', () => {
		// The polarity is the opposite of include_failed on purpose: a failure rate
		// you cannot see is a lie, so failures default IN; a configuration already
		// ruled out is not a candidate, so it defaults OUT.
		expect(includeBlacklistedFromQuery(new URL('http://x/api/cells'))).toBe(false);
		expect(includeBlacklistedFromQuery(new URL('http://x/api/cells?include_blacklisted=1'))).toBe(
			true
		);
		expect(includeBlacklistedFromQuery(new URL('http://x/api/cells?include_blacklisted=0'))).toBe(
			false
		);
		// Anything other than the literal "1" is not an opt-in.
		expect(
			includeBlacklistedFromQuery(new URL('http://x/api/cells?include_blacklisted=true'))
		).toBe(false);
	});
});

describe('parseScope', () => {
	test('model is required and trimmed', () => {
		expect(parseScope({}).ok).toBe(false);
		expect(parseScope({ model: '   ' }).ok).toBe(false);
		const parsed = parseScope({ model: '  a/b  ' });
		expect(parsed.ok && parsed.entry.model).toBe('a/b');
	});

	test('`*` and an omitted effort both mean "every level"', () => {
		// Stored as undefined either way, so an entry written from the UI is
		// byte-identical to one `bench:blacklist --add` would write.
		const star = parseScope({ model: 'm', effort: '*' });
		expect(star.ok && star.entry.effort).toBeUndefined();
		const absent = parseScope({ model: 'm' });
		expect(absent.ok && absent.entry.effort).toBeUndefined();
		const level = parseScope({ model: 'm', effort: 'none' });
		expect(level.ok && level.entry.effort).toBe('none');
	});

	test('backend is constrained to the two real ones', () => {
		expect(parseScope({ model: 'm', backend: 'openrouter' }).ok).toBe(true);
		expect(parseScope({ model: 'm', backend: 'claude' }).ok).toBe(true);
		expect(parseScope({ model: 'm', backend: 'ollama' }).ok).toBe(false);
	});

	test('non-string fields are ignored rather than coerced', () => {
		expect(parseScope({ model: 42 }).ok).toBe(false);
		const parsed = parseScope({ model: 'm', effort: 7 });
		expect(parsed.ok && parsed.entry.effort).toBeUndefined();
	});
});

describe('writeRefusal', () => {
	const jsonPost = (headers: Record<string, string> = {}) =>
		new Request('http://127.0.0.1:8792/api/blacklist', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: '{}'
		});

	const ok = { readOnly: false, blacklistError: null };

	test('a same-origin JSON POST is allowed', () => {
		expect(writeRefusal(jsonPost({ origin: 'http://127.0.0.1:8792' }), ok)).toBeNull();
		// No Origin at all (curl, a fetch from the served page in some browsers) is
		// fine — the Host check upstream already established who we are answering.
		expect(writeRefusal(jsonPost(), ok)).toBeNull();
		expect(writeRefusal(jsonPost({ origin: 'http://localhost:8792' }), ok)).toBeNull();
	});

	test('a cross-origin write is refused even though the Host header passed', () => {
		expect(writeRefusal(jsonPost({ origin: 'https://evil.example' }), ok)).toContain(
			'cross-origin'
		);
		expect(writeRefusal(jsonPost({ origin: 'not-a-url' }), ok)).toContain('cross-origin');
	});

	test('a non-JSON content type is refused — that is what forces the preflight', () => {
		const form = new Request('http://127.0.0.1:8792/api/blacklist', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'model=m'
		});
		expect(writeRefusal(form, ok)).toContain('application/json');
	});

	test('--read-only disables writes outright', () => {
		expect(writeRefusal(jsonPost(), { readOnly: true, blacklistError: null })).toContain(
			'--read-only'
		);
	});

	test('an unreadable blacklist refuses writes rather than overwriting it', () => {
		// Saving here would serialize the empty in-memory fallback over verdicts we
		// simply could not parse — a silent data loss dressed as a successful click.
		expect(
			writeRefusal(jsonPost(), { readOnly: false, blacklistError: 'not valid JSON' })
		).toContain('unreadable');
	});
});

describe('resolveAsset', () => {
	const dist = 'bench-viewer/dist';

	test('resolves a normal asset path inside dist', () => {
		expect(resolveAsset(dist, '/assets/index.js')).toBe(resolve(dist, 'assets/index.js'));
	});

	test('traversal never escapes dist', () => {
		// Localhost-only is not a reason to serve the repo, and a browser can send
		// a path curl would have normalized away. Every one of these resolves to a
		// (usually non-existent) path INSIDE dist — which the caller then misses
		// and falls back to index.html — rather than reaching a real repo file.
		const root = resolve(dist);
		for (const attack of [
			'/../package.json',
			'/../../etc/passwd',
			'/%2e%2e/%2e%2e/package.json',
			'/assets/../../../../wrangler.jsonc'
		]) {
			const resolved = resolveAsset(dist, attack);
			expect(resolved).not.toBeNull();
			expect(resolved?.startsWith(root)).toBe(true);
			expect(resolved).not.toBe(resolve('package.json'));
		}
	});

	test('refuses malformed encodings and null bytes', () => {
		expect(resolveAsset(dist, '/%E0%A4%A')).toBeNull();
		expect(resolveAsset(dist, '/a%00b')).toBeNull();
	});

	test('the dist root itself resolves', () => {
		expect(resolveAsset(dist, '/')).toBe(resolve(dist));
	});
});
