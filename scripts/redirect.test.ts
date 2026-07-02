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
