/// <reference types="bun-types" />
// Exercises buildSitemapXml — the pure XML builder behind /sitemap.xml. The
// invariants that matter: the canonical map root is always the first <url>;
// each entry becomes a /locations/<id> <loc>; <lastmod> appears exactly when
// last_verified is known; and every interpolated value is XML-escaped so a
// hostile id can never break the document.

import { test, expect } from 'bun:test';
import { buildSitemapXml } from '../src/lib/server/sitemap';

test('an empty entry list still yields a well-formed urlset with the map root first', () => {
	const xml = buildSitemapXml([]);
	expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
	expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
	expect(xml).toContain('<url><loc>https://betterfoodmaps.com/</loc></url>');
	expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
});

test('each entry becomes a /locations/<id> loc, root first, in input order', () => {
	const xml = buildSitemapXml([
		{ id: 'venue-a', last_verified: '2026-06-30' },
		{ id: 'venue-b', last_verified: null }
	]);
	const root = xml.indexOf('<loc>https://betterfoodmaps.com/</loc>');
	const a = xml.indexOf('<loc>https://betterfoodmaps.com/locations/venue-a</loc>');
	const b = xml.indexOf('<loc>https://betterfoodmaps.com/locations/venue-b</loc>');
	expect(root).toBeGreaterThan(-1);
	expect(a).toBeGreaterThan(root);
	expect(b).toBeGreaterThan(a);
});

test('lastmod carries last_verified when known and is omitted when null', () => {
	const xml = buildSitemapXml([
		{ id: 'dated', last_verified: '2026-06-30' },
		{ id: 'undated', last_verified: null }
	]);
	expect(xml).toContain(
		'<url><loc>https://betterfoodmaps.com/locations/dated</loc><lastmod>2026-06-30</lastmod></url>'
	);
	// The undated venue's <url> closes straight after its <loc> — no empty or
	// invented <lastmod>.
	expect(xml).toContain('<url><loc>https://betterfoodmaps.com/locations/undated</loc></url>');
	expect(xml.split('<lastmod>').length - 1).toBe(1);
});

test('interpolated values are XML-escaped, so a hostile id cannot break the document', () => {
	// encodeURIComponent percent-encodes & < > " out of the path but leaves '
	// untouched — the XML escaping must catch what URL-encoding lets through.
	const xml = buildSitemapXml([{ id: `o'malley&sons <"deli">`, last_verified: '2026 & later' }]);
	expect(xml).toContain(
		`<loc>https://betterfoodmaps.com/locations/o&apos;malley%26sons%20%3C%22deli%22%3E</loc>`
	);
	expect(xml).toContain('<lastmod>2026 &amp; later</lastmod>');
	// No raw specials survive anywhere in the document body: every remaining `&`
	// starts an entity, and the only angle brackets are the markup's own tags.
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toMatch(/<(?!\?|\/?(?:urlset|url|loc|lastmod)[ >])/);
});
