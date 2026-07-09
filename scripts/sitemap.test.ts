/// <reference types="bun-types" />
// Exercises the pure sitemap builders behind /sitemap.xml (the index) and
// /sitemaps/<n>.xml (the pages). Only the pure module is imported here:
// sitemap-cache.ts reaches $app/server transitively and cannot load under
// `bun test`. The invariants that matter: page-count math (an empty dataset is
// still one page); the map root on page 1 alone; each entry becomes a
// /locations/<name>-<city>-<uuid> <loc> with <lastmod> exactly when
// last_verified is known; the index numbers its pages and carries each page's
// MAX lastmod; and every interpolated value is XML-escaped so a hostile field
// can never break the document. Page-size-dependent cases pass a small synthetic
// pageSize rather than materialising 40k-entry arrays.

import { expect, test } from 'bun:test';
import {
	buildSitemapIndexXml,
	buildSitemapPageXml,
	SITEMAP_PAGE_SIZE,
	sitemapPageCount,
	type SitemapEntry
} from '../src/lib/server/sitemap';

const UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const UUID_B = 'f6e5d4c3-b2a1-4f8e-9d0c-1b2a3f4e5d6c';

/** A UUID-id entry (gets a descriptive slug), with sensible name/city defaults. */
function entry(over: Partial<SitemapEntry> & { id: string }): SitemapEntry {
	return { name: 'Prado Cafe', city: 'Vancouver', last_verified: null, ...over };
}

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

test('each entry becomes a slugged /locations/<…> loc, root first, in input order', () => {
	const xml = buildSitemapPageXml(
		[
			entry({ id: UUID_A, name: 'Revolver', city: 'Vancouver', last_verified: '2026-06-30' }),
			entry({ id: UUID_B, name: 'Prado Cafe', city: 'Vancouver' })
		],
		{ includeRoot: true }
	);
	const root = xml.indexOf('<loc>https://betterfoodmaps.com/</loc>');
	const a = xml.indexOf(
		`<loc>https://betterfoodmaps.com/locations/revolver-vancouver-${UUID_A}</loc>`
	);
	const b = xml.indexOf(
		`<loc>https://betterfoodmaps.com/locations/prado-cafe-vancouver-${UUID_B}</loc>`
	);
	expect(root).toBeGreaterThan(-1);
	expect(a).toBeGreaterThan(root);
	expect(b).toBeGreaterThan(a);
});

test('a legacy short-slug id gets no descriptive prefix', () => {
	// A non-UUID id (the ~20 seed venues) is already a readable slug and stays
	// bare — a prefixed form would be unparseable by idFromPath.
	const xml = buildSitemapPageXml([entry({ id: 'wr-damianos', name: "Damiano's Pizza" })], {
		includeRoot: false
	});
	expect(xml).toContain('<loc>https://betterfoodmaps.com/locations/wr-damianos</loc>');
});

test('pages after the first omit the map root', () => {
	const xml = buildSitemapPageXml([entry({ id: UUID_A, name: 'Revolver' })], {
		includeRoot: false
	});
	expect(xml).not.toContain('<loc>https://betterfoodmaps.com/</loc>');
	expect(xml).toContain(
		`<loc>https://betterfoodmaps.com/locations/revolver-vancouver-${UUID_A}</loc>`
	);
});

test('lastmod carries last_verified when known and is omitted when null', () => {
	const xml = buildSitemapPageXml(
		[
			entry({ id: UUID_A, name: 'Dated', last_verified: '2026-06-30' }),
			entry({ id: UUID_B, name: 'Undated', last_verified: null })
		],
		{ includeRoot: true }
	);
	expect(xml).toContain(
		`<url><loc>https://betterfoodmaps.com/locations/dated-vancouver-${UUID_A}</loc><lastmod>2026-06-30</lastmod></url>`
	);
	// The undated venue's <url> closes straight after its <loc> — no empty or
	// invented <lastmod>.
	expect(xml).toContain(
		`<url><loc>https://betterfoodmaps.com/locations/undated-vancouver-${UUID_B}</loc></url>`
	);
	expect(xml.split('<lastmod>').length - 1).toBe(1);
});

test('the index numbers one sitemap per page and carries each page max lastmod', () => {
	// pageSize 2 → pages [a,b] [c,d] [e]: max-of-page (not first/last), a page
	// of all-null lastmods omits the element, and a lone dated entry carries its
	// own date.
	const entries: SitemapEntry[] = [
		entry({ id: UUID_A, last_verified: '2026-01-05' }),
		entry({ id: UUID_B, last_verified: '2026-03-20' }),
		entry({ id: 'c', last_verified: null }),
		entry({ id: 'd', last_verified: null }),
		entry({ id: 'e', last_verified: '2025-12-31' })
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

test('interpolated values are XML-escaped, so a hostile field cannot break the document', () => {
	// A legacy non-UUID id embeds verbatim (percent-encoded), and a hostile name
	// folds through slugify to a plain slug — both then XML-escaped. Feed both a
	// specials-laden id and lastmod to prove escaping catches what URL-encoding
	// leaves through (notably `'`).
	const xml = buildSitemapPageXml(
		[{ id: `o'malley&sons`, name: 'Deli', city: 'Town', last_verified: '2026 & later' }],
		{ includeRoot: true }
	);
	// encodeURIComponent leaves `'` (→ escaped to &apos;) but encodes & to %26.
	expect(xml).toContain(`<loc>https://betterfoodmaps.com/locations/o&apos;malley%26sons</loc>`);
	expect(xml).toContain('<lastmod>2026 &amp; later</lastmod>');
	// No raw specials survive anywhere in the document body: every remaining `&`
	// starts an entity, and the only angle brackets are the markup's own tags.
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toMatch(/<(?!\?|\/?(?:urlset|url|loc|lastmod)[ >])/);
});

test('the index escapes lastmod values under the same discipline', () => {
	const xml = buildSitemapIndexXml([entry({ id: UUID_A, last_verified: `<'2026' & "later">` })], 2);
	expect(xml).toContain('<lastmod>&lt;&apos;2026&apos; &amp; &quot;later&quot;&gt;</lastmod>');
	expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	expect(xml).not.toMatch(/<(?!\?|\/?(?:sitemapindex|sitemap|loc|lastmod)[ >])/);
});
