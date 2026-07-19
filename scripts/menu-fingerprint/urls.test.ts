/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import { deriveWatchUrls, extractUrls, MAX_WATCH_URLS, sanitizeUrls } from './urls';

test('extractUrls: pulls urls out of refresh_notes prose, trailing punctuation trimmed', () => {
	const notes =
		'Menu spans https://cafe.example/menu, https://cafe.example/drinks. ' +
		'Feed endpoint: https://order.example/api/v2/menu?store=42 (JS-rendered page).';
	expect(extractUrls(notes)).toEqual([
		'https://cafe.example/menu',
		'https://cafe.example/drinks',
		'https://order.example/api/v2/menu?store=42'
	]);
});

test('deriveWatchUrls: merges sources + notes, dedupes, strips fragments, drops socials', () => {
	const urls = deriveWatchUrls(
		['https://cafe.example/menu', 'https://www.facebook.com/cafepage'],
		'Pages: https://cafe.example/menu#food and https://cafe.example/desserts. ' +
			'Also https://instagram.com/cafe and https://maps.app.goo.gl/xyz'
	);
	expect(urls).toEqual(['https://cafe.example/menu', 'https://cafe.example/desserts']);
});

test('deriveWatchUrls: invalid urls are skipped, cap applies', () => {
	const many = Array.from({ length: 30 }, (_, i) => `https://cafe.example/page${i}`);
	expect(deriveWatchUrls(['not a url'], many.join(' '))).toHaveLength(MAX_WATCH_URLS);
	expect(deriveWatchUrls([], null)).toEqual([]);
});

test('google.com skips exactly — docs/sites/drive subdomains stay watchable', () => {
	const urls = deriveWatchUrls(
		[
			'https://docs.google.com/document/d/abc/menu',
			'https://www.google.com/maps/place/cafe',
			'https://google.com/search?q=cafe',
			'https://maps.google.com/xyz'
		],
		null
	);
	expect(urls).toEqual(['https://docs.google.com/document/d/abc/menu']);
});

test('sanitizeUrls (explicit --urls path): validates + dedupes but does NOT host-skip', () => {
	expect(
		sanitizeUrls([
			'https://cafe.example/menu#food',
			'https://cafe.example/menu',
			'not a url',
			'https://www.yelp.com/biz/cafe' // operator explicitly asked; trusted
		])
	).toEqual(['https://cafe.example/menu', 'https://www.yelp.com/biz/cafe']);
});
