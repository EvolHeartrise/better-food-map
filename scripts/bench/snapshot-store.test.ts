import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLinks, looksLikeBotWall, prioritize } from './record';
import { candidateUrls, resolveTarget, rewriteBody, rewriteLocation } from './serve';
import {
	extFor,
	findEntry,
	isTextType,
	normalizeUrl,
	SnapshotStore,
	type SnapshotIndex
} from './snapshot-store';

describe('normalizeUrl', () => {
	test('strips fragments and default ports, lowercases host', () => {
		expect(normalizeUrl('https://Example.com:443/Menu?a=1#top')).toBe(
			'https://example.com/Menu?a=1'
		);
		expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
		expect(normalizeUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x');
	});
});

describe('extFor / isTextType', () => {
	test('maps common content types', () => {
		expect(extFor('text/html; charset=utf-8')).toBe('html');
		expect(extFor('application/pdf')).toBe('pdf');
		expect(extFor('application/vnd.api+json')).toBe('json');
		expect(extFor(null)).toBe('bin');
	});
	test('text detection covers json and xml suffixes', () => {
		expect(isTextType('application/json')).toBe(true);
		expect(isTextType('image/svg+xml')).toBe(true);
		expect(isTextType('image/png')).toBe(false);
		expect(isTextType(null)).toBe(false);
	});
});

describe('findEntry', () => {
	const index: SnapshotIndex = {
		entries: [
			{
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				size: 1,
				recordedAt: ''
			},
			{
				method: 'POST',
				url: 'https://x.com/api',
				requestBody: '{"q":"drinks"}',
				status: 200,
				contentType: 'application/json',
				size: 1,
				recordedAt: ''
			},
			{
				method: 'POST',
				url: 'https://x.com/api',
				requestBody: '{"q":"food"}',
				status: 200,
				contentType: 'application/json',
				size: 1,
				recordedAt: ''
			}
		]
	};
	test('matches GET by normalized url', () => {
		expect(findEntry(index, 'get', 'https://X.com/menu#frag')?.status).toBe(200);
	});
	test('POST matches exact body first, falls back to url-only', () => {
		expect(findEntry(index, 'POST', 'https://x.com/api', '{"q":"food"}')?.requestBody).toBe(
			'{"q":"food"}'
		);
		// unknown body still replays something rather than 404ing
		expect(findEntry(index, 'POST', 'https://x.com/api', '{"q":"other"}')).toBeDefined();
	});
	test('misses return undefined', () => {
		expect(findEntry(index, 'GET', 'https://x.com/nope')).toBeUndefined();
		expect(findEntry(index, 'GET', 'not a url')).toBeUndefined();
	});
});

describe('SnapshotStore', () => {
	test('put/body round-trips and re-put replaces, keeping rendered pointer', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-store-'));
		try {
			const store = new SnapshotStore(dir);
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: new TextEncoder().encode('<p>old</p>')
			});
			store.putRendered('https://x.com/menu', '<p>rendered</p>');
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: new TextEncoder().encode('<p>new</p>')
			});
			store.save();

			const reloaded = new SnapshotStore(dir);
			expect(reloaded.index.entries).toHaveLength(1);
			const entry = findEntry(reloaded.index, 'GET', 'https://x.com/menu');
			if (!entry) throw new Error('entry missing after reload');
			expect(new TextDecoder().decode(reloaded.body(entry))).toBe('<p>new</p>');
			expect(reloaded.renderedHtml(entry)).toBe('<p>rendered</p>');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('hosts() lists unique recorded hosts', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bench-store-'));
		try {
			const store = new SnapshotStore(dir);
			store.put({ method: 'GET', url: 'https://x.com/', status: 200, contentType: 'text/html' });
			store.put({
				method: 'GET',
				url: 'https://api.x.com/menu',
				status: 200,
				contentType: 'application/json'
			});
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html'
			});
			expect(store.hosts().toSorted()).toEqual(['api.x.com', 'x.com']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('extractLinks / prioritize', () => {
	test('keeps same-host http(s) links, resolves relative, drops assets and fragments', () => {
		const links = extractLinks(
			[
				'/menu',
				'drinks.html',
				'https://x.com/about#team',
				'https://other.com/menu',
				'mailto:a@b.c',
				'/logo.png',
				'/menu.pdf'
			],
			'https://x.com/home/',
			'x.com'
		);
		expect(links).toEqual([
			'https://x.com/menu',
			'https://x.com/home/drinks.html',
			'https://x.com/about',
			'https://x.com/menu.pdf'
		]);
	});
	test('bot-wall detection ignores anti-bot SDK mentions outside visible text', () => {
		// Wix/CF embed reCAPTCHA scripts on every page — title/text is what counts
		expect(looksLikeBotWall(200, 'Pure Vegetarian Menu | Mysite', 'Samosas $6 …')).toBe(false);
		expect(looksLikeBotWall(200, 'Just a moment...', 'Checking your browser')).toBe(true);
		expect(looksLikeBotWall(200, 'Menu', 'Verify you are human to continue')).toBe(true);
		expect(looksLikeBotWall(403, 'Menu', 'anything')).toBe(true);
	});
	test('menu-shaped URLs sort first', () => {
		expect(
			prioritize(['https://x.com/about', 'https://x.com/dinner-menu', 'https://x.com/contact'])[0]
		).toBe('https://x.com/dinner-menu');
	});
});

describe('serve routing', () => {
	test('primary host and __origin__ paths resolve', () => {
		expect(resolveTarget('/menu', '?a=1', 'x.com')).toEqual({
			host: 'x.com',
			pathAndQuery: '/menu?a=1'
		});
		expect(resolveTarget('/__origin__/api.x.com/v1/items', '', 'x.com')).toEqual({
			host: 'api.x.com',
			pathAndQuery: '/v1/items'
		});
		expect(resolveTarget('/__origin__/api.x.com', '', 'x.com')).toEqual({
			host: 'api.x.com',
			pathAndQuery: '/'
		});
		expect(resolveTarget('/__origin__/', '', 'x.com')).toBeUndefined();
	});
	test('candidateUrls tries https then http', () => {
		expect(candidateUrls({ host: 'x.com', pathAndQuery: '/m' })).toEqual([
			'https://x.com/m',
			'http://x.com/m'
		]);
	});
	test('rewriteBody routes recorded hosts through the replay server', () => {
		const out = rewriteBody(
			'<a href="https://x.com/menu">m</a><script src="//cdn.x.com/a.js"></script> fetch("https://api.x.com/v1")',
			['x.com', 'api.x.com', 'cdn.x.com'],
			'x.com',
			'http://localhost:8787'
		);
		expect(out).toContain('href="http://localhost:8787/menu"');
		expect(out).toContain('src="http://localhost:8787/__origin__/cdn.x.com/a.js"');
		expect(out).toContain('fetch("http://localhost:8787/__origin__/api.x.com/v1")');
	});
	test('rewriteLocation only touches recorded hosts', () => {
		expect(rewriteLocation('https://x.com/menu', ['x.com'], 'x.com', 'http://localhost:8787')).toBe(
			'http://localhost:8787/menu'
		);
		expect(
			rewriteLocation('https://elsewhere.com/', ['x.com'], 'x.com', 'http://localhost:8787')
		).toBe('https://elsewhere.com/');
		expect(rewriteLocation('/relative', ['x.com'], 'x.com', 'http://localhost:8787')).toBe(
			'/relative'
		);
	});
});
