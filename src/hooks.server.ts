import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	SESSION_COOKIE,
	clearSessionCookie,
	setSessionCookie,
	validateSessionToken
} from '$lib/server/auth';
import { deleteExpiredSessions } from '$lib/server/db';

// betterfoodmaps.com is the canonical domain. The legacy bare domain
// betterfoodmap.com is also routed to this Worker (see wrangler.jsonc) purely so
// it can be 301-redirected here, preserving the path and query string. The
// redirect runs before `resolve`, so betterfoodmap.com never serves app content.
const CANONICAL_HOST = 'betterfoodmaps.com';
const REDIRECT_HOSTS = new Set(['betterfoodmap.com', 'www.betterfoodmap.com']);

const canonicalHost: Handle = async ({ event, resolve }) => {
	const { hostname, pathname, search } = event.url;
	if (REDIRECT_HOSTS.has(hostname)) {
		return new Response(null, {
			status: 301,
			headers: { location: `https://${CANONICAL_HOST}${pathname}${search}` }
		});
	}
	return resolve(event);
};

// Resolves the session cookie into `event.locals.user` / `event.locals.session`
// for every request, so remote functions and routes can read who is signed in.
// An invalid/expired token clears the cookie; a still-valid one whose expiry was
// slid forward re-sets it (the only time we touch Set-Cookie, to keep responses
// cacheable otherwise).
const authenticate: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const db = event.platform?.env?.DB;
	event.locals.user = null;
	event.locals.session = null;

	// Opportunistically sweep expired session rows on ~1% of requests, in the
	// background via waitUntil so it adds zero request latency. validateSessionToken
	// only deletes an expired row when that same cookie returns, so sessions of
	// users who never come back would pile up forever. Sampling ties the purge
	// cadence to traffic, and the table is small enough that occasional passes
	// suffice. Errors are swallowed — a failed purge must never affect the request.
	if (db && Math.random() < 0.01) {
		event.platform?.ctx?.waitUntil(deleteExpiredSessions(db, Date.now()).catch(() => {}));
	}

	if (token && db) {
		const result = await validateSessionToken(db, token);
		if (result) {
			event.locals.user = result.user;
			event.locals.session = result.session;
			if (result.refreshed) setSessionCookie(event.cookies, token, result.session.expires_at);
		} else {
			clearSessionCookie(event.cookies);
		}
	}

	return resolve(event);
};

// Content-Security-Policy, sent in production only: under `vite dev` the HMR
// websocket and Vite's injected style/script tags would violate the policy and
// break live reload, so the dev server runs without it. Each directive mirrors
// a piece of the app's actual runtime surface:
// • script/style allow 'unsafe-inline' because SvelteKit hydrates via inline
//   scripts and Svelte injects component styles inline — a nonce-based strict
//   CSP would be a separate, riskier change.
// • MapLibre GL spawns its worker from a blob: URL (worker-src blob:) and may
//   materialize tile/sprite images as blob:/data: URLs (img-src blob: data:).
// • Raster tiles are FETCHED by MapLibre (XHR/fetch, not <img>) from the
//   openstreetmap.org tile hosts (see mapStyle in LocationMap.svelte), so those
//   hosts live in connect-src; they're also in img-src as a safety net should
//   MapLibre ever load one via an Image element instead.
// • Signed-in users' Google avatars (`user.picture`, AccountMenu.svelte) are
//   served from *.googleusercontent.com.
// • Cloudflare Web Analytics is enabled on the zone, which auto-injects its RUM
//   beacon into served HTML: the script loads from static.cloudflareinsights.com
//   (script-src) and posts its measurements to cloudflareinsights.com
//   (connect-src). Omitting these blocks the beacon — a console violation on
//   every page view and silently missing analytics data.
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data: https://*.tile.openstreetmap.org https://*.googleusercontent.com",
	"connect-src 'self' https://*.tile.openstreetmap.org https://cloudflareinsights.com",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'"
].join('; ');

// Stamps browser security headers onto every response the Worker serves —
// pages, remote functions, and the sitemap XML alike (which is why this lives
// here rather than in SvelteKit's `csp` config, which only covers documents).
// It runs first in the sequence so responses that short-circuit before
// `resolve` (the canonicalHost 301) still pass back through it.
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// The app never asks the browser for camera/mic/location — user location
	// comes from Cloudflare's IP-derived `platform.cf` coordinates on the server
	// (getUserLocation in src/lib/data.remote.ts) — so all three are locked off.
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	// Redundant with CSP frame-ancestors, but covers older browsers and dev
	// (where the CSP is absent).
	response.headers.set('X-Frame-Options', 'DENY');
	// No `includeSubDomains`: it would pin every subdomain of the zone to HTTPS,
	// and we haven't verified none of them is HTTP-only. Gated on !dev like the
	// CSP (browsers ignore HSTS over plain HTTP anyway, so this is consistency,
	// not a functional requirement).
	if (!dev) response.headers.set('Strict-Transport-Security', 'max-age=31536000');
	if (!dev) response.headers.set('Content-Security-Policy', CSP);
	return response;
};

// The map is public — there is no navigation gate. `authenticate` still runs so an
// optional signed-in user (account menu, likes, saved diet) is resolved for every
// request; the user-scoped remote functions guard themselves with `requireUser()`.
export const handle = sequence(securityHeaders, canonicalHost, authenticate);
