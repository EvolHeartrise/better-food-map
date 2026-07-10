/// <reference types="bun-types" />
// Exercises the /api/v1 CORS helper (src/lib/server/api.ts): an allow-listed
// Origin is echoed back, a disallowed Origin gets no Access-Control-Allow-Origin,
// an Origin-less request is unaffected (native fetch plugins), and the OPTIONS
// preflight carries the right method/header/max-age shape. No wildcard ever.

import { test, expect } from 'bun:test';
import {
	API_ALLOWED_ORIGINS,
	apiPreflightResponse,
	applyApiResponseHeaders
} from '../src/lib/server/api-cors';

function reqWithOrigin(origin: string | null): Request {
	const headers = new Headers();
	if (origin !== null) headers.set('origin', origin);
	return new Request('https://betterfoodmaps.com/api/v1/me', { headers });
}

test('allow-listed origins are exactly the app WebView origins', () => {
	expect([...API_ALLOWED_ORIGINS].toSorted()).toEqual(
		['capacitor://localhost', 'http://localhost:5050', 'https://localhost'].toSorted()
	);
});

test('applyApiResponseHeaders echoes an allow-listed Origin and sets no-store + Vary', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin('capacitor://localhost'), res);
	expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
	expect(res.headers.get('cache-control')).toBe('no-store');
	expect(res.headers.get('vary')).toContain('Origin');
});

test('applyApiResponseHeaders does NOT echo a disallowed Origin', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin('https://evil.example'), res);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	// Still no-store + Vary, just no ACAO — and never a wildcard.
	expect(res.headers.get('cache-control')).toBe('no-store');
	expect(res.headers.get('vary')).toContain('Origin');
});

test('applyApiResponseHeaders leaves an Origin-less request unblocked (additive only)', () => {
	const res = new Response('{}');
	applyApiResponseHeaders(reqWithOrigin(null), res);
	// No Origin → no ACAO header, but the response is otherwise untouched/usable —
	// a native no-Origin client is not subject to the browser CORS gate.
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	expect(res.headers.get('cache-control')).toBe('no-store');
});

test('preflight: allow-listed Origin gets full CORS headers, 204', () => {
	const res = apiPreflightResponse(reqWithOrigin('https://localhost'));
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBe('https://localhost');
	expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, OPTIONS');
	expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
	expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0);
	expect(res.headers.get('vary')).toContain('Origin');
});

test('preflight: a disallowed Origin gets the shape but no ACAO (browser will block)', () => {
	const res = apiPreflightResponse(reqWithOrigin('https://evil.example'));
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
	expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, OPTIONS');
});
