import { describe, expect, test } from 'bun:test';
import type { BenchManifest } from '../snapshot-store';
import { buildTimeline, fetchedUrls, hasMenuWord, pageCoverage, toolCallUrl } from './transcript';

function manifest(urls: string[]): BenchManifest {
	return {
		entryUrl: urls[0] ?? 'https://v.com/',
		primaryHost: 'v.com',
		createdAt: '2026-08-01T00:00:00.000Z',
		lastRecordedAt: '2026-08-01T00:00:00.000Z',
		pages: urls.map((url, depth) => ({ url, status: 200, title: '', depth })),
		warnings: [],
		counts: { pages: urls.length, responses: urls.length, hosts: 1 }
	};
}

describe('toolCallUrl', () => {
	test('parses fetch_page JSON-string arguments', () => {
		expect(toolCallUrl({ name: 'fetch_page', arguments: '{"url":"https://v.com/menu"}' })).toBe(
			'https://v.com/menu'
		);
	});
	test('accepts an already-parsed object', () => {
		expect(toolCallUrl({ name: 'fetch_page', arguments: { url: 'https://v.com/' } })).toBe(
			'https://v.com/'
		);
	});
	test('ignores other tools and malformed arguments', () => {
		expect(toolCallUrl({ name: 'submit_menu', arguments: '{"items":[]}' })).toBeUndefined();
		expect(toolCallUrl({ name: 'fetch_page', arguments: '{oops' })).toBeUndefined();
	});
});

describe('buildTimeline', () => {
	test('computes inter-event latency, null on the first event', () => {
		const timeline = buildTimeline([
			{ type: 'request', ts: '2026-08-04T19:40:31.000Z' },
			{ type: 'response', ts: '2026-08-04T19:40:33.500Z' }
		]);
		expect(timeline[0].delta_ms).toBeNull();
		expect(timeline[1].delta_ms).toBe(2500);
	});

	test('lifts usage, cache reads, reasoning tokens and provenance off a response', () => {
		const [turn] = buildTimeline([
			{
				type: 'response',
				ts: '2026-08-04T19:40:31.000Z',
				provider: 'GMICloud',
				response_id: 'gen-1',
				usage: {
					prompt_tokens: 2396,
					completion_tokens: 68,
					cost: 0.000062,
					prompt_tokens_details: { cached_tokens: 2304 },
					completion_tokens_details: { reasoning_tokens: 15 }
				}
			}
		]);
		expect(turn.prompt_tokens).toBe(2396);
		expect(turn.cached_tokens).toBe(2304);
		expect(turn.reasoning_tokens).toBe(15);
		expect(turn.cost).toBeCloseTo(0.000062);
		expect(turn.provider).toBe('GMICloud');
		expect(turn.response_id).toBe('gen-1');
	});

	test('a null provider (older runs) stays undefined rather than becoming a string', () => {
		const [turn] = buildTimeline([
			{ type: 'response', ts: '2026-08-04T19:40:31.000Z', provider: null }
		]);
		expect(turn.provider).toBeUndefined();
	});
});

describe('fetchedUrls', () => {
	test('returns distinct urls in first-request order', () => {
		expect(
			fetchedUrls([
				{ type: 'tool_call', name: 'fetch_page', arguments: '{"url":"https://v.com/"}' },
				{ type: 'tool_call', name: 'fetch_page', arguments: '{"url":"https://v.com/menu"}' },
				{ type: 'tool_call', name: 'fetch_page', arguments: '{"url":"https://v.com/"}' },
				{ type: 'tool_result', name: 'fetch_page', result: {} }
			])
		).toEqual(['https://v.com/', 'https://v.com/menu']);
	});
});

describe('hasMenuWord (a sort hint, never a denominator)', () => {
	test('matches menu words as whole path tokens', () => {
		expect(hasMenuWord('https://v.com/menu')).toBe(true);
		expect(hasMenuWord('https://v.com/drink-menu/')).toBe(true);
		expect(hasMenuWord('https://v.com/meet-brunch')).toBe(true);
		expect(hasMenuWord('https://v.com/happy-hour-menu/')).toBe(true);
	});

	test('does not substring-match a menu word inside another word', () => {
		// Real case from the corpus: /locations/eaton-centre was being reported as
		// an unopened MENU page because "eaton" contains "eat".
		expect(hasMenuWord('https://www.newyorkfries.com/locations/eaton-centre')).toBe(false);
		expect(hasMenuWord('https://v.com/theatre')).toBe(false);
		expect(hasMenuWord('https://v.com/reorder-history')).toBe(false);
	});

	test('a query string is not part of the path', () => {
		expect(hasMenuWord('https://v.com/about?ref=menu')).toBe(false);
	});

	test('a malformed url falls back to raw tokenizing rather than throwing', () => {
		expect(() => hasMenuWord('not a url')).not.toThrow();
		expect(hasMenuWord('/menu')).toBe(true);
	});
});

describe('pageCoverage', () => {
	const pages = manifest([
		'https://v.com/',
		'https://v.com/menu',
		'https://v.com/drinks',
		'https://v.com/about'
	]);

	test('counts recorded pages the model opened', () => {
		const coverage = pageCoverage(pages, ['https://v.com/', 'https://v.com/menu']);
		expect(coverage?.available).toBe(4);
		expect(coverage?.visited).toBe(2);
		expect(coverage?.ratio).toBeCloseTo(0.5);
	});

	test('an unopened drinks page is surfaced in the blind-spot list', () => {
		// The classic exhaustiveness failure: a whole drinks page never opened.
		const coverage = pageCoverage(pages, ['https://v.com/', 'https://v.com/menu']);
		expect(coverage?.unvisited).toContain('https://v.com/drinks');
	});

	test('menu-shaped pages sort ahead of the rest in unvisited', () => {
		const coverage = pageCoverage(pages, ['https://v.com/']);
		expect(coverage?.unvisited[0]).toBe('https://v.com/drinks');
	});

	test('urls match after normalization, not by raw string', () => {
		const coverage = pageCoverage(manifest(['https://v.com/menu']), ['https://V.com/menu#section']);
		expect(coverage?.visited).toBe(1);
	});

	test('off-manifest fetches are reported, not penalized', () => {
		// Hitting the ordering API directly is often the right move.
		const coverage = pageCoverage(pages, ['https://v.com/api/menu.json']);
		expect(coverage?.off_manifest).toEqual(['https://v.com/api/menu.json']);
		expect(coverage?.visited).toBe(0);
	});

	test('a malformed fetched url is skipped rather than throwing', () => {
		expect(() => pageCoverage(pages, ['not a url'])).not.toThrow();
	});

	test('a menu page with no menu word still counts as unvisited', () => {
		// New York Fries serves its menu from /fries, /poutine, /dips. A ratio built
		// on the word list scored a run that opened only /menu at a perfect 100%
		// while it skipped all of those, so no such ratio is published: the exact
		// visited/available number and the full unvisited list are what remain.
		const nyf = manifest([
			'https://v.com/menu',
			'https://v.com/fries',
			'https://v.com/poutine',
			'https://v.com/dips'
		]);
		const coverage = pageCoverage(nyf, ['https://v.com/menu']);
		expect(coverage?.visited).toBe(1);
		expect(coverage?.available).toBe(4);
		expect(coverage?.ratio).toBeCloseTo(0.25);
		expect(coverage?.unvisited).toEqual([
			'https://v.com/dips',
			'https://v.com/fries',
			'https://v.com/poutine'
		]);
		expect(coverage).not.toHaveProperty('menu_ratio');
	});

	test('no manifest means no coverage claim', () => {
		expect(pageCoverage(undefined, ['https://v.com/'])).toBeNull();
		expect(pageCoverage(manifest([]), ['https://v.com/'])).toBeNull();
	});
});
