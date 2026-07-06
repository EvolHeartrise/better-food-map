import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	LEGACY_SESSION_COOKIE,
	SESSION_COOKIE,
	clearSessionCookie,
	createLazySessionResolver,
	setSessionCookie
} from '$lib/server/auth';
import { deleteExpiredSessions } from '$lib/server/db';

// betterfoodmaps.com is the canonical domain. The canonical www host, the
// legacy bare domain betterfoodmap.com, and its www are also routed to this
// Worker (see wrangler.jsonc routes — this set must stay in sync with them;
// scripts/redirect.test.ts enforces that) purely so they can be 301-redirected
// here, preserving the path and query string. The redirect runs before
// `resolve`, so none of these hosts ever serves app content.
const CANONICAL_HOST = 'betterfoodmaps.com';
const REDIRECT_HOSTS = new Set([
	'www.betterfoodmaps.com',
	'betterfoodmap.com',
	'www.betterfoodmap.com'
]);

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

// Installs `event.locals.getSession` — a LAZY, per-request-memoized resolver of
// the session cookie — so only code that actually asks who is signed in (the
// user-scoped remote functions, via `currentUser()`/`requireUser()` in
// $lib/server/context) pays the D1 session read. The map's public paths
// (getMapCells/getStats/getLocationData, the sitemap routes) never call it, so
// a signed-in user's cell fetches stay D1-free behind the colo cell cache and
// don't burn a Workers Free subrequest on auth. Semantics on first call are
// exactly the old eager hook's: an invalid/expired token clears the cookie; a
// still-valid one whose expiry was slid forward re-sets it (the only times we
// touch Set-Cookie, to keep responses cacheable otherwise).
//
// Cookie lifecycle note: the resolver closes over THIS hook's `event.cookies`
// (not the guarded wrapper a `query` remote function sees), which is deliberate
// — the refresh/clear is hook-level session upkeep that was merely deferred,
// and it must still land even when the first consumer is a query like
// getCurrentUser/getLikes, whose own `cookies.set` is forbidden. SvelteKit
// collects cookies set any time before the response is constructed, so writes
// from within SSR or a remote-endpoint request still reach Set-Cookie.
const authenticate: Handle = async ({ event, resolve }) => {
	// `__Host-` migration: sessions opened before the cookie rename still arrive
	// under the legacy unprefixed name. Fall back to that token for this request;
	// once it validates (lazily, below) the token is re-set under the prefixed
	// name and the legacy cookie is deleted, so deployed users stay signed in.
	// In dev the two names are identical and `legacyToken` is always undefined.
	const prefixedToken = event.cookies.get(SESSION_COOKIE);
	const legacyToken =
		!prefixedToken && SESSION_COOKIE !== LEGACY_SESSION_COOKIE
			? event.cookies.get(LEGACY_SESSION_COOKIE)
			: undefined;
	const token = prefixedToken ?? legacyToken;
	const db = event.platform?.env?.DB;

	// Opportunistically sweep expired session rows on ~1% of requests, in the
	// background via waitUntil so it adds zero request latency. validateSessionToken
	// only deletes an expired row when that same cookie returns, so sessions of
	// users who never come back would pile up forever. Sampling ties the purge
	// cadence to traffic, and the table is small enough that occasional passes
	// suffice. Errors are swallowed — a failed purge must never affect the request.
	if (db && Math.random() < 0.01) {
		event.platform?.ctx?.waitUntil(deleteExpiredSessions(db, Date.now()).catch(() => {}));
	}

	const getSession = createLazySessionResolver(db, token, {
		setCookie: (t, expiresAt) => setSessionCookie(event.cookies, t, expiresAt),
		// clearSessionCookie drops the legacy name too, so an invalid/expired
		// legacy token doesn't keep coming back on every request.
		clearCookie: () => clearSessionCookie(event.cookies)
	});

	// When the token rode in on the legacy cookie, migrate it on first successful
	// resolution: re-set it under the prefixed name (keeping the row's expiry) and
	// drop the legacy cookie. Stays lazy — public paths that never resolve the
	// session write no cookies, exactly as before; the migration then simply
	// happens on a later request that does.
	event.locals.getSession = !legacyToken
		? getSession
		: async () => {
				const resolved = await getSession();
				if (resolved) {
					setSessionCookie(event.cookies, legacyToken, resolved.session.expires_at);
					event.cookies.delete(LEGACY_SESSION_COOKIE, { path: '/' });
				}
				return resolved;
			};

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

// The map is public — there is no navigation gate. `authenticate` only installs
// the lazy resolver; the optional signed-in user (account menu, likes, saved
// diet) is resolved on demand, and the user-scoped remote functions guard
// themselves with `requireUser()`.
export const handle = sequence(securityHeaders, canonicalHost, authenticate);
