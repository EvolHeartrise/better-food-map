/// <reference types="bun-types" />
// Pure/parseable parts of the fetch layer — no network, no Chromium, no
// pdftotext binary (CI has none of the latter two).
import { test, expect } from 'bun:test';
import {
	classifyKind,
	looksLikePdf,
	normalizeTextLines,
	outcomeFromBytes,
	pdfContentHash,
	type RawFetchResult
} from './fetcher';
import { needsRenderedPromotion } from './baseline';
import type { BaselineRow } from './db';

const enc = new TextEncoder();

function raw(body: string, contentType: string): RawFetchResult {
	return {
		status: 200,
		notModified: false,
		contentType,
		bytes: enc.encode(body),
		etag: null,
		lastModified: null
	};
}

// ---------------------------------------------------------------------------
// pdf: degenerate extracted text must never produce a trusted text hash
// ---------------------------------------------------------------------------

test('pdfContentHash: image-only PDFs (empty extracted text) fall back to byte hashing', () => {
	const scanA = enc.encode('%PDF-1.4 scanned-menu-A');
	const scanB = enc.encode('%PDF-1.4 scanned-menu-B');
	// Two genuinely different scans with no extractable text must NEVER compare
	// equal — hashing the empty text would make them identical forever.
	expect(pdfContentHash(scanA, '')).not.toBe(pdfContentHash(scanB, ''));
	expect(pdfContentHash(scanA, '')).toStartWith('bytes:');
	expect(pdfContentHash(scanA, '   \n \n ')).toStartWith('bytes:');
	expect(pdfContentHash(scanA, null)).toStartWith('bytes:');
});

test('pdfContentHash: substantial extracted text hashes as text (byte churn invisible)', () => {
	const text = Array.from({ length: 20 }, (_, i) => `Dish ${i} with sauce  ${i + 8}.95`).join('\n');
	const a = pdfContentHash(enc.encode('%PDF regenerated-monday'), text);
	const b = pdfContentHash(enc.encode('%PDF regenerated-tuesday'), text);
	expect(a).toBe(b);
	expect(a).toStartWith('text:');
});

test('looksLikePdf / classifyKind', () => {
	expect(looksLikePdf(enc.encode('%PDF-1.7'))).toBe(true);
	expect(looksLikePdf(enc.encode('<html>'))).toBe(false);
	expect(classifyKind('application/json; charset=utf-8', enc.encode('{}'))).toBe('feed');
	expect(classifyKind('application/pdf', enc.encode('%PDF'))).toBe('pdf');
	expect(classifyKind('text/html', enc.encode('%PDF'))).toBe('pdf'); // magic wins over a lying header
	expect(classifyKind('text/html', enc.encode('<html>'))).toBe('html');
});

test('normalizeTextLines: collapses whitespace into the visibleText line shape', () => {
	expect(normalizeTextLines('  Pad Thai   16.95  \n\n\n  Curry  18.00 ')).toBe(
		'Pad Thai 16.95\nCurry 18.00'
	);
});

// ---------------------------------------------------------------------------
// SPA-shell guard: an ok html row without a price signal is never trusted as-is
// ---------------------------------------------------------------------------

const SHELL_HTML = `<html><head><title>Cafe Nova</title></head><body>
	<nav>Home About Contact Careers Gift Cards Press Catering Private Events</nav>
	<div id="root"></div>
	<footer>Cafe Nova is a neighbourhood spot serving seasonal fare since 2012.
	Follow us on social media for updates. 123 Example Street, Vancouver BC.
	Open Tuesday through Sunday. All rights reserved. Privacy policy. Terms of use.</footer>
	</body></html>`;

test('a 200 SPA shell fingerprints ok/html with NO price signal — and is flagged for rendered promotion', async () => {
	const outcome = await outcomeFromBytes(
		{ url: 'https://cafe.example/menu', kind: 'html', etag: null, last_modified: null },
		raw(SHELL_HTML, 'text/html')
	);
	// >MIN_TEXT_LEN of nav/footer text: passes the degenerate check…
	expect(outcome.fetch_status).toBe('ok');
	expect(outcome.signal_hash).toBeNull();
	// …which is exactly why baseline must NOT trust it: the menu (arriving via
	// JS/iframe) is invisible to this hash, so it would compare "stable" forever.
	const row: BaselineRow = {
		url: 'https://cafe.example/menu',
		kind: 'html',
		content_hash: outcome.content_hash,
		signal_hash: outcome.signal_hash,
		etag: null,
		last_modified: null,
		fetch_status: 'ok'
	};
	expect(needsRenderedPromotion(row)).toBe(true);
});

test('needsRenderedPromotion: trusted and non-html rows are left alone', () => {
	const base: BaselineRow = {
		url: 'https://cafe.example/menu',
		kind: 'html',
		content_hash: 'text:aaa',
		signal_hash: 'signal:sss',
		etag: null,
		last_modified: null,
		fetch_status: 'ok'
	};
	expect(needsRenderedPromotion(base)).toBe(false); // ok html WITH signal
	expect(needsRenderedPromotion({ ...base, signal_hash: null, fetch_status: 'blocked' })).toBe(
		true
	); // walled html retries via Chromium
	expect(needsRenderedPromotion({ ...base, kind: 'feed', signal_hash: null })).toBe(false);
	expect(needsRenderedPromotion({ ...base, kind: 'pdf', signal_hash: null })).toBe(false);
});
