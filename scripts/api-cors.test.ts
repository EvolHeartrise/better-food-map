/// <reference types="bun-types" />
// Exercises the /api/v1 CORS helper (src/lib/server/api.ts): an allow-listed
// Origin is echoed back, a disallowed Origin gets no Access-Control-Allow-Origin,
// an Origin-less request is unaffected (native fetch plugins), and the OPTIONS
// preflight carries the right method/header/max-age shape. No wildcard ever.

import { test, expect } from 'bun:test';
import {
	API_PROD_ALLOWED_ORIGINS,
	API_DEV_ORIGIN,
	MAX_API_BODY_BYTES,
	apiAllowedOrigins,
	apiBodyTooLarge,
	apiPreflightResponse,
	applyApiResponseHeaders
} from '../src/lib/server/api-cors';

// The effective allowlist in production (dev origin excluded), used by most tests.
const PROD = apiAllowedOrigins(false);

function reqWithOrigin(origin: string | null): Request {
	const headers = new Headers();
	if (origin !== null) headers.set('origin', origin);
	return new Request('https://betterfoodmaps.com/api/v1/me', { headers });
}

test('production allowlist is exactly the two app WebView origins (no dev origin)', () => {
	expect([...API_PROD_ALLOWED_ORIGINS].toSorted()).toEqual(
		['capacitor://localhost', 'https://localhost'].toSorted()
	);
	// The prod build's effective allowlist matches — the dev origin is NOT shipped.
	expect([...apiAllowedOrigins(false)].toSorted()).toEqual(
		['capacitor://localhost', 'https://localhost'].toSorted()
	);
	expect(apiAllowedOrigins(false).has(API_DEV_ORIGIN)).toBe(false);
});

test('dev allowlist adds ONLY the local vite dev origin', () => {
	expect([...apiAllowedOrigins(true)].toSorted()).toEqual(
		['capacitor://localhost', 'http://localhost:5050', 'https://localhost'].toSorted()
	);
	expect(apiAllowedOrigins(true).has(API_DEV_ORIGIN)).toBe(true);
});

test('prod does NOT echo the dev origin, but dev does', () => {
	const prodRes = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin(API_DEV_ORIGIN), prodRes, PROD);
	expect(prodRes.headers.get('access-control-allow-origin')).toBeNull();

	const devRes = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin(API_DEV_ORIGIN), devRes, apiAllowedOrigins(true));
	expect(devRes.headers.get('access-control-allow-origin')).toBe(API_DEV_ORIGIN);
});

test('applyApiResponseHeaders echoes an allow-listed Origin and sets no-store + Vary', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin('capacitor://localhost'), res, PROD);
	expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
	expect(res.headers.get('cache-control')).toBe('no-store');
	expect(res.headers.get('vary')).toContain('Origin');
});

test('applyApiResponseHeaders does NOT echo a disallowed Origin', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin('https://evil.example'), res, PROD);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	// Still no-store + Vary, just no ACAO — and never a wildcard.
	expect(res.headers.get('cache-control')).toBe('no-store');
	expect(res.headers.get('vary')).toContain('Origin');
});

test('applyApiResponseHeaders leaves an Origin-less request unblocked (additive only)', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin(null), res, PROD);
	// No Origin → no ACAO header, but the response is otherwise untouched/usable —
	// a native no-Origin client is not subject to the browser CORS gate.
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	expect(res.headers.get('cache-control')).toBe('no-store');
});

test('preflight: allow-listed Origin gets full CORS headers, 204', () => {
	const res = apiPreflightResponse(reqWithOrigin('https://localhost'), PROD);
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBe('https://localhost');
	expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, OPTIONS');
	expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
	expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0);
	expect(res.headers.get('vary')).toContain('Origin');
});

test('preflight: a disallowed Origin gets the shape but no ACAO (browser will block)', () => {
	const res = apiPreflightResponse(reqWithOrigin('https://evil.example'), PROD);
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, OPTIONS');
});

test('apiBodyTooLarge: rejects an over-cap Content-Length before reading', () => {
	expect(apiBodyTooLarge(String(MAX_API_BODY_BYTES + 1))).toBe(true);
	expect(apiBodyTooLarge(String(MAX_API_BODY_BYTES))).toBe(false);
	expect(apiBodyTooLarge('0')).toBe(false);
});

test('apiBodyTooLarge: a missing/garbage Content-Length is ignored (no false reject)', () => {
	expect(apiBodyTooLarge(null)).toBe(false);
	expect(apiBodyTooLarge('')).toBe(false);
	expect(apiBodyTooLarge('not-a-number')).toBe(false);
});

test('apiBodyTooLarge: the defensive text check catches an under-reported body', () => {
	// Content-Length absent/lying, but the actual body text exceeds the cap.
	expect(apiBodyTooLarge(null, 'x'.repeat(MAX_API_BODY_BYTES + 1))).toBe(true);
	expect(apiBodyTooLarge(null, 'x'.repeat(MAX_API_BODY_BYTES))).toBe(false);
	expect(apiBodyTooLarge('5', 'x'.repeat(MAX_API_BODY_BYTES + 1))).toBe(true);
});
