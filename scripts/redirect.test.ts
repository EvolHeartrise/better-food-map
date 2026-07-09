/// <reference types="bun-types" />
// Locks in safeInternalPath — the open-redirect / header-splitting guard between
// attacker-controlled `?redirectTo` / redirect-cookie values and the 302 Location
// header issued by the login and OAuth-callback routes. The invariants: only a
// bare same-origin absolute path passes through unchanged; protocol-relative
// (`//host`, `/\host`) and absolute-URL forms fall back; control characters
// (CRLF header splitting, tabs, NUL, DEL) fall back; empty/null input falls back.

import { test, expect } from 'bun:test';
import { safeInternalPath, DEFAULT_REDIRECT } from '../src/lib/redirect';

test('a plain internal path passes through unchanged', () => {
	expect(safeInternalPath('/a/b?c=d')).toBe('/a/b?c=d');
	expect(safeInternalPath('/')).toBe('/');
	expect(safeInternalPath('/place/toronto-on/some-venue#menu')).toBe(
		'/place/toronto-on/some-venue#menu'
	);
});

test('null, undefined and empty values fall back to the default redirect', () => {
	expect(safeInternalPath(null)).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath(undefined)).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('')).toBe(DEFAULT_REDIRECT);
});

test('absolute URLs are rejected — the open-redirect case', () => {
	expect(safeInternalPath('https://evil.com')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('http://evil.com/phish')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('javascript:alert(1)')).toBe(DEFAULT_REDIRECT);
});

test('protocol-relative forms are rejected — browsers resolve them cross-origin', () => {
	expect(safeInternalPath('//evil.com')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('//evil.com/path')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/\\evil.com')).toBe(DEFAULT_REDIRECT);
});

test('relative (non-absolute) paths are rejected', () => {
	expect(safeInternalPath('foo/bar')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('../etc')).toBe(DEFAULT_REDIRECT);
});

test('control characters are rejected — CRLF header splitting and friends', () => {
	expect(safeInternalPath('/ok\r\nSet-Cookie:x')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/ok\rx')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/ok\nx')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/ok\ttab')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/ok\u0000nul')).toBe(DEFAULT_REDIRECT);
	expect(safeInternalPath('/ok\u007fdel')).toBe(DEFAULT_REDIRECT);
});

test('a custom fallback is returned for rejected values and ignored for safe ones', () => {
	expect(safeInternalPath('//evil.com', '/account')).toBe('/account');
	expect(safeInternalPath(null, '/account')).toBe('/account');
	expect(safeInternalPath('/settings', '/account')).toBe('/settings');
});

// ---------------------------------------------------------------------------
// Canonical-host drift guard. Cloudflare `custom_domain` routes match the
// EXACT hostname only, so every host that must 301 to the canonical apex needs
// BOTH a route in wrangler.jsonc AND an entry in REDIRECT_HOSTS in
// src/hooks.server.ts. hooks.server.ts imports $app/* so it can't be imported
// under `bun test`; instead we extract both host lists from source text and
// assert they tell the same story: routes = { canonical } ∪ REDIRECT_HOSTS.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const hooksSrc = readFileSync(join(root, 'src/hooks.server.ts'), 'utf8');
const wranglerSrc = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');

function extract(re: RegExp, src: string, label: string): string {
	const m = src.match(re);
	if (!m) throw new Error(`could not locate ${label}`);
	return m[1];
}

const canonicalHost = extract(
	/const CANONICAL_HOST = '([^']+)'/,
	hooksSrc,
	'CANONICAL_HOST in src/hooks.server.ts'
);
const redirectHosts = [
	...extract(
		/const REDIRECT_HOSTS = new Set\(\[([\s\S]*?)\]\)/,
		hooksSrc,
		'REDIRECT_HOSTS in src/hooks.server.ts'
	).matchAll(/'([^']+)'/g)
].map((m) => m[1]);
const routedHosts = [
	...extract(/"routes":\s*\[([\s\S]*?)\]/, wranglerSrc, 'routes in wrangler.jsonc').matchAll(
		/"pattern":\s*"([^"]+)"/g
	)
].map((m) => m[1]);

test('every wrangler route is either the canonical host or a redirect host', () => {
	expect(routedHosts.length).toBeGreaterThan(0);
	const known = new Set([canonicalHost, ...redirectHosts]);
	for (const host of routedHosts) expect(known).toContain(host);
});

test('every redirect host has a wrangler custom-domain route (else it never reaches the Worker)', () => {
	expect(redirectHosts.length).toBeGreaterThan(0);
	for (const host of redirectHosts) expect(routedHosts).toContain(host);
});

test('the canonical host is routed and not redirected to itself', () => {
	expect(routedHosts).toContain(canonicalHost);
	expect(redirectHosts).not.toContain(canonicalHost);
});

test('both www hosts and the alias apex 301 to the canonical apex', () => {
	expect(canonicalHost).toBe('betterfoodmaps.com');
	expect(new Set(redirectHosts)).toEqual(
		new Set(['www.betterfoodmaps.com', 'betterfoodmap.com', 'www.betterfoodmap.com'])
	);
});
