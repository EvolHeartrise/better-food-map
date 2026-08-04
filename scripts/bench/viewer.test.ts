import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
	filterFromQuery,
	parseArgs,
	parseDimensions,
	parseMetric,
	parseMode,
	resolveAsset
} from './viewer';
import { DEFAULT_DIMENSIONS } from './analyze/aggregate';

describe('parseArgs', () => {
	test('defaults', () => {
		const parsed = parseArgs([]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args).toEqual({
				port: 8792,
				runsDir: 'bench/runs',
				tasksDir: 'bench/tasks',
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
			'--rebuild',
			'--no-build'
		]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args).toEqual({
				port: 9000,
				runsDir: 'a',
				tasksDir: 'b',
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
