/// <reference types="bun-types" />
// Locks in the untrusted-URL guards from issue #86: website and source URLs
// arrive from world-editable feeds (OSM tags, agent citations) and are
// rendered as anchor hrefs, so `javascript:`/`data:`/other non-http(s)
// schemes must never become a link. safeHttpUrl is the render-side allowlist
// (also covering rows already stored); hasNonHttpScheme is the ingestion-side
// rejection test; the source-citation schema must refuse hostile URLs that
// valibot's v.url() alone would accept.

import { test, expect } from 'bun:test';
import * as v from 'valibot';
import { safeHttpUrl, hasNonHttpScheme } from '../src/lib/safe-url';
import { sourceInputSchema } from './mcp/source-input';

test('safeHttpUrl passes http(s) URLs through unchanged', () => {
	expect(safeHttpUrl('https://example.com/menu')).toBe('https://example.com/menu');
	expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
	expect(safeHttpUrl('https://example.com/path?q=1#frag')).toBe(
		'https://example.com/path?q=1#frag'
	);
});

test('safeHttpUrl rejects executable and non-web schemes', () => {
	expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
	// eslint-disable-next-line no-script-url -- the attack string under test
	expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull(); // scheme is case-insensitive
	expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
	expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
	expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
	expect(safeHttpUrl('ftp://example.com')).toBeNull();
});

test('safeHttpUrl rejects strings that do not parse as absolute URLs', () => {
	expect(safeHttpUrl('example.com')).toBeNull(); // scheme-less: plain text, not a link
	expect(safeHttpUrl('/relative/path')).toBeNull();
	expect(safeHttpUrl('')).toBeNull();
	expect(safeHttpUrl('not a url')).toBeNull();
});

test('hasNonHttpScheme flags only values carrying an explicit non-http(s) scheme', () => {
	expect(hasNonHttpScheme('javascript:alert(1)')).toBe(true);
	expect(hasNonHttpScheme('data:text/html,x')).toBe(true);
	expect(hasNonHttpScheme('https://example.com')).toBe(false);
	expect(hasNonHttpScheme('http://example.com')).toBe(false);
	// Scheme-less/unparseable values pass ingestion — the render guard keeps
	// them as plain text — so sloppy-but-harmless OSM tags are not dropped.
	expect(hasNonHttpScheme('example.com')).toBe(false);
	expect(hasNonHttpScheme('')).toBe(false);
});

test('source schema accepts http(s) URLs in both input shapes', () => {
	expect(v.parse(sourceInputSchema, 'https://example.com/menu')).toEqual({
		url: 'https://example.com/menu',
		label: null
	});
	expect(v.parse(sourceInputSchema, { url: 'http://example.com', label: 'Menu' })).toEqual({
		url: 'http://example.com',
		label: 'Menu'
	});
});

test('source schema rejects javascript: URLs in both input shapes', () => {
	// eslint-disable-next-line no-script-url -- the attack string under test
	const hostile = 'javascript:alert(1)';
	expect(() => v.parse(sourceInputSchema, hostile)).toThrow();
	expect(() => v.parse(sourceInputSchema, { url: hostile, label: 'Official menu' })).toThrow();
	expect(() => v.parse(sourceInputSchema, { url: 'data:text/html,x' })).toThrow();
});
