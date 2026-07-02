/// <reference types="bun-types" />
// Exercises the pure sitemap builders behind /sitemap.xml (the index) and
// /sitemaps/<n>.xml (the pages). Only the pure module is imported here:
// sitemap-cache.ts reaches $app/server transitively and cannot load under
// `bun test`. The invariants that matter: page-count math (an empty dataset is
// still one page); the map root on page 1 alone; each entry becomes a
// /locations/<id> <loc> with <lastmod> exactly when last_verified is known;
// the index numbers its pages and carries each page's MAX lastmod; and every
// interpolated value is XML-escaped so a hostile id can never break the
// document. Page-size-dependent cases pass a small synthetic pageSize rather
// than materialising 40k-entry arrays.

import { expect, test } from 'bun:test';
import {
	buildSitemapIndexXml,
	buildSitemapPageXml,
	SITEMAP_PAGE_SIZE,
	sitemapPageCount,
	type SitemapEntry
} from '../src/lib/server/sitemap';

test('page count is ceil(total / pageSize), never zero', () => {
	expect(sitemapPageCount(0)).toBe(1); // empty dataset → one (root-only) page
	expect(sitemapPageCount(1)).toBe(1);
	expect(sitemapPageCount(SITEMAP_PAGE_SIZE)).toBe(1); // exactly full → still one
	expect(sitemapPageCount(SITEMAP_PAGE_SIZE + 1)).toBe(2); // one over → spills
	// Same math at a synthetic page size.
	expect(sitemapPageCount(6, 2)).toBe(3);
	expect(sitemapPageCount(7, 2)).toBe(4);
});

test('an empty page 1 still yields a well-formed urlset with the map root', () => {
	const xml = buildSitemapPageXml([], { includeRoot: true });
	expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
	expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
	expect(xml).toContain('<url><loc>https://betterfoodmaps.com/</loc></url>');
	expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
});

test('each entry becomes a /locations/<id> loc, root first, in input order', () => {
	const xml = buildSitemapPageXml(
		[
			{ id: 'venue-a', last_verified: '2026-06-30' },
			{ id: 'venue-b', last_verified: null }
		],
		{ includeRoot: true }
	);
	const root = xml.indexOf('<loc>https://betterfoodmaps.com/</loc>');
	const a = xml.indexOf('<loc>https://betterfoodmaps.com/locations/venue-a</loc>');
	const b = xml.indexOf('<loc>https://betterfoodmaps.com/locations/venue-b</loc>');
	expect(root).toBeGreaterThan(-1);
	expect(a).toBeGreaterThan(root);
	expect(b).toBeGreaterThan(a);
});

test('pages after the first omit the map root', () => {
	const xml = buildSitemapPageXml([{ id: 'venue-a', last_verified: null }], {
		includeRoot: false
	});
	expect(xml).not.toContain('<loc>https://betterfoodmaps.com/</loc>');
	expect(xml).toContain('<loc>https://betterfoodmaps.com/locations/venue-a</loc>');
});

test('lastmod carries last_verified when known and is omitted when null', () => {
	const xml = buildSitemapPageXml(
		[
			{ id: 'dated', last_verified: '2026-06-30' },
			{ id: 'undated', last_verified: null }
		],
		{ includeRoot: true }
	);
	expect(xml).toContain(
		'<url><loc>https://betterfoodmaps.com/locations/dated</loc><lastmod>2026-06-30</lastmod></url>'
	);
	// The undated venue's <url> closes straight after its <loc> — no empty or
	// invented <lastmod>.
	expect(xml).toContain('<url><loc>https://betterfoodmaps.com/locations/undated</loc></url>');
	expect(xml.split('<lastmod>').length - 1).toBe(1);
});

test('the index numbers one sitemap per page and carries each page max lastmod', () => {
	// pageSize 2 → pages [a,b] [c,d] [e]: max-of-page (not first/last), a page
	// of all-null lastmods omits the element, and a lone dated entry carries its
	// own date.
	const entries: SitemapEntry[] = [
		{ id: 'a', last_verified: '2026-01-05' },
		{ id: 'b', last_verified: '2026-03-20' },
		{ id: 'c', last_verified: null },
		{ id: 'd', last_verified: null },
		{ id: 'e', last_verified: '2025-12-31' }
	];
	const xml = buildSitemapIndexXml(entries, 2);
	expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
	expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
	expect(xml).toContain(
		'<sitemap><loc>https://betterfoodmaps.com/sitemaps/1.xml</loc><lastmod>2026-03-20</lastmod></sitemap>'
	);
	expect(xml).toContain('<sitemap><loc>https://betterfoodmaps.com/sitemaps/2.xml</loc></sitemap>');
	expect(xml).toContain(
		'<sitemap><loc>https://betterfoodmaps.com/sitemaps/3.xml</loc><lastmod>2025-12-31</lastmod></sitemap>'
	);
	expect(xml).not.toContain('/sitemaps/4.xml');
	expect(xml.trimEnd().endsWith('</sitemapindex>')).toBe(true);
});

test('an empty dataset still yields an index referencing /sitemaps/1.xml', () => {
	const xml = buildSitemapIndexXml([], 2);
	expect(xml).toContain('<sitemap><loc>https://betterfoodmaps.com/sitemaps/1.xml</loc></sitemap>');
	expect(xml).not.toContain('/sitemaps/2.xml');
});

test('interpolated values are XML-escaped, so a hostile id cannot break the document', () => {
	// encodeURIComponent percent-encodes & < > " out of the path but leaves '
	// untouched — the XML escaping must catch what URL-encoding lets through.
	const xml = buildSitemapPageXml(
		[{ id: `o'malley&sons <"deli">`, last_verified: '2026 & later' }],
		{
			includeRoot: true
		}
	);
	expect(xml).toContain(
		`<loc>https://betterfoodmaps.com/locations/o&apos;malley%26sons%20%3C%22deli%22%3E</loc>`
	);
	expect(xml).toContain('<lastmod>2026 &amp; later</lastmod>');
	// No raw specials survive anywhere in the document body: every remaining `&`
	// starts an entity, and the only angle brackets are the markup's own tags.
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toMatch(/<(?!\?|\/?(?:urlset|url|loc|lastmod)[ >])/);
});

test('the index escapes lastmod values under the same discipline', () => {
	const xml = buildSitemapIndexXml([{ id: 'a', last_verified: `<'2026' & "later">` }], 2);
	expect(xml).toContain('<lastmod>&lt;&apos;2026&apos; &amp; &quot;later&quot;&gt;</lastmod>');
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toMatch(/<(?!\?|\/?(?:sitemapindex|sitemap|loc|lastmod)[ >])/);
});
