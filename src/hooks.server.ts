import { AsyncLocalStorage } from 'node:async_hooks';
import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	baseLocale,
	extractLocaleFromHeader,
	isLocale,
	overwriteGetLocale,
	type Locale
} from '$lib/paraglide/runtime';
import {
	LEGACY_SESSION_COOKIE,
	SESSION_COOKIE,
	clearSessionCookie,
	createLazySessionResolver,
	parseBearerToken,
	sessionSourceFor,
	setSessionCookie
} from '$lib/server/auth';
import {
	API_V1_PREFIX,
	apiAllowedOrigins,
	apiPreflightResponse,
	applyApiResponseHeaders
} from '$lib/server/api-cors';
import { LOCALE_COOKIE } from '$lib/server/locale-cookie';
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

	// BEARER path (the mobile app): the app can't use cookies, so it presents its
	// session as `Authorization: Bearer <token>`. Resolve it through the SAME lazy,
	// memoized machinery, but with a no-op cookie sink — a bearer request reads and
	// writes NO cookies (a sliding-expiry refresh still updates the D1 row; it just
	// can't re-set a cookie that doesn't exist). Taken before any cookie read so the
	// browser cookie path below is byte-for-byte untouched. A request carrying both a
	// bearer header and cookies (not a real client shape) resolves via the bearer
	// token and leaves the cookies alone.
	// Record HOW this request's session is resolved so mutating /api/v1 routes can
	// require the bearer path (requireBearerUser in $lib/server/api) and reject a
	// cookie-driven mutation. Set for EVERY request, before either branch.
	const authHeader = event.request.headers.get('authorization');
	event.locals.sessionSource = sessionSourceFor(authHeader);

	const bearer = parseBearerToken(authHeader);
	if (bearer) {
		const noCookies = { setCookie: () => {}, clearCookie: () => {} };
		event.locals.getSession = createLazySessionResolver(db, bearer, noCookies);
		return resolve(event);
	}

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

// --- i18n locale resolution -------------------------------------------------
//
// Phase 1 of the localization effort: resolve a request locale and expose it to
// (a) `event.locals.locale`, (b) Paraglide's server-side message runtime, and
// (c) the `<html lang>` attribute — WITHOUT any visible UI change and WITHOUT
// ever writing a cookie. Accept-Language auto-detection is the default and needs
// no storage (so there are no consent-banner implications).
//
// Paraglide's server `getLocale()` is a per-request value. We hold it in an
// AsyncLocalStorage store (Cloudflare Workers support it via `nodejs_compat`)
// and point `getLocale()` at that store with `overwriteGetLocale`. Every request
// — page SSR *and* each remote-function (`*.remote.ts`) invocation, which is its
// own HTTP request through this same `handle` — runs its downstream inside
// `localeStorage.run(locale, …)`, so message functions resolve the caller's
// locale with no cross-request leakage. Outside a request (e.g. prerender) the
// store is empty and `getLocale()` falls back to `baseLocale`.
const localeStorage = new AsyncLocalStorage<Locale>();
overwriteGetLocale(() => localeStorage.getStore() ?? baseLocale);

// Resolves the request locale with a fixed precedence:
//   1. explicit preference cookie, if present   (LOCALE_COOKIE, written by the
//      setLocale command on an active pick — see $lib/server/locale-cookie)
//   2. signed-in user's saved locale            (folded into getSessionWithUser)
//   3. Accept-Language header, q-value weighted  (Paraglide's own negotiator,
//      which matches full tags then base tags against the supported locales)
//   4. baseLocale ('en-US')
//
// Async because step 2 awaits the session lookup. `authenticate` runs before
// `localize` in the sequence (below), so `event.locals.getSession` is installed
// by the time we get here — but we still gate the call on a session cookie being
// present so a signed-out request never pays a D1 read just to resolve its locale.
async function resolveLocale(event: Parameters<Handle>[0]['event']): Promise<Locale> {
	// 1. Explicit preference cookie: this browser's active pick wins over
	//    everything, even a later sign-in's saved locale on THIS device.
	const cookieLocale = event.cookies.get(LOCALE_COOKIE);
	if (cookieLocale && isLocale(cookieLocale)) return cookieLocale;

	// 2. Signed-in user's saved locale, read from the SAME memoized session lookup
	//    the auth hook uses — getSessionWithUser LEFT JOINs user_locale, so this
	//    adds no extra D1 round trip. Three guards:
	//    • DOCUMENT requests only. A top-level navigation is where `<html lang>`
	//      and the rendered chrome are decided. Remote-function calls (getMapCells,
	//      …), client-nav data requests and SSR sub-requests are data, not chrome —
	//      their only locale-sensitive output is error strings. Resolving the
	//      session on every one of them would put a serial D1 read ahead of
	//      responses that are otherwise pure colo-cache hits (regressing the
	//      lazy-session property) and could attach a session Set-Cookie to a
	//      cacheable response. So we skip them; a user who wants remote responses
	//      localized has an explicit cookie (step 1), which needs no session read.
	//    • Session cookie present, so a signed-OUT request stays D1-free.
	//    • Wrapped so a saved-locale read can NEVER 500 a page. In the window after
	//      this code deploys but before migration 0024 (user_locale) is applied, the
	//      LEFT JOIN throws `no such table`; we swallow it and fall through to
	//      Accept-Language rather than letting a locale nicety take the site down.
	const isDocumentRequest = !event.isDataRequest && !event.isSubRequest && !event.isRemoteRequest;
	if (
		isDocumentRequest &&
		(event.cookies.get(SESSION_COOKIE) ?? event.cookies.get(LEGACY_SESSION_COOKIE))
	) {
		try {
			const resolved = await event.locals.getSession();
			if (resolved && isLocale(resolved.locale)) return resolved.locale;
		} catch {
			// Saved-locale read failed (e.g. pre-migration) — fall through.
		}
	}

	// 3. Accept-Language, q-weighted. Returns undefined when no tag maps to a
	//    supported locale (e.g. `de,es;q=0.8`), so it falls through to step 4.
	const headerLocale = extractLocaleFromHeader(event.request);
	if (headerLocale) return headerLocale;

	// 4. Fallback.
	return baseLocale;
}

// Route ids whose responses are PUBLIC, edge-cacheable, English-by-design crawl
// surfaces: the geographic browse tree and the sitemaps all send
// `Cache-Control: public, max-age=…`. A cached response must not vary by request,
// so these routes render a single request-independent locale — otherwise the first
// `fr` visitor's page (with `<html lang="fr">` and French digit grouping over
// English content) is edge-cached and served to everyone, crawlers included,
// corrupting language classification on the very pages that exist for SEO. Pin them
// to `baseLocale`: no cookie / Accept-Language / session resolution at all (which
// also keeps a session Set-Cookie off these cacheable responses). These pages are
// deliberately an English crawl surface — see the localization notes in CLAUDE.md.
function isPublicEnglishSurface(routeId: string | null): boolean {
	if (!routeId) return false;
	return (
		routeId === '/places' ||
		routeId === '/sitemap.xml' ||
		routeId.startsWith('/sitemaps/') ||
		routeId.startsWith('/[country=geo]')
	);
}

// The right-to-left locales: their pages get `<html dir="rtl">` so text runs the
// right way. Document-level only — the map UI is not RTL-audited; mirroring the
// chrome is acceptable and MapLibre's canvas is direction-agnostic.
const RTL_LOCALES: ReadonlySet<string> = new Set(['ur', 'fa', 'ar']);

// Runs after `authenticate` (so `event.locals.getSession` exists for step 2 of
// resolveLocale) and wraps the app resolve, so `getLocale()` is live for the whole
// render. Fills `<html lang="%lang%" dir="%textdir%">` via transformPageChunk.
// `sequence` merges this transformPageChunk with any others. No cookie is written
// here — the locale cookie is written only by the setLocale command on an active pick.
const localize: Handle = async ({ event, resolve }) => {
	const locale = isPublicEnglishSurface(event.route.id) ? baseLocale : await resolveLocale(event);
	event.locals.locale = locale;
	return localeStorage.run(locale, () =>
		resolve(event, {
			// replaceAll, not replace: a stray copy of a token elsewhere in the chunk
			// (it happened — an app.html comment once swallowed the one-shot replace
			// and shipped literal %lang%, snapping every client render back to the
			// base locale) must never leave the real attribute unstamped.
			transformPageChunk: ({ html }) =>
				html
					.replaceAll('%lang%', locale)
					.replaceAll('%textdir%', RTL_LOCALES.has(locale) ? 'rtl' : 'ltr')
		})
	);
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
// • Vector tiles are FETCHED by MapLibre (XHR/fetch, not <img>) from our
//   self-hosted PMTiles worker at tiles.betterfoodmaps.com (see mapStyle in
//   LocationMap.svelte; the tile URL template is inlined there, so tiles are
//   the only fetch), so that origin lives in connect-src. Glyphs and sprites
//   are same-origin under /basemaps-assets ('self'); MapLibre materializes tile
//   and sprite images as blob:/data: URLs, already covered by img-src.
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
	"img-src 'self' blob: data: https://*.googleusercontent.com",
	"connect-src 'self' https://tiles.betterfoodmaps.com https://cloudflareinsights.com",
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

// CORS + no-store for the mobile app's JSON API (`/api/v1/*`, see
// src/routes/api/v1 and $lib/server/api). Applied as a hook rather than per route
// so EVERY /api/v1 response is covered uniformly — successes, thrown errors, and
// framework 404s for unknown /api/v1 paths alike — and no route can forget it:
//   • OPTIONS is answered here as the CORS preflight, before any route logic;
//   • every other /api/v1 response gets the exact-origin CORS headers (echoing an
//     allow-listed Origin only) and `Cache-Control: no-store`.
// no-store matters because these are per-user surfaces (bearer-auth likes/diet)
// and even the public ones are keyed on user-suppliable input — none may be
// shared/edge-cached, mirroring how remote functions are no-store today. These
// paths are NOT the public English crawl surface (isPublicEnglishSurface), so the
// locale pinning there doesn't touch them.
// The effective CORS allowlist, built once from `dev` (from $app/environment):
// the production WebView origins plus the local `vite dev` origin ONLY in dev, so
// the dev origin never ships in the production allowlist.
const API_ORIGINS = apiAllowedOrigins(dev);

const apiCors: Handle = async ({ event, resolve }) => {
	if (!event.url.pathname.startsWith(API_V1_PREFIX)) return resolve(event);
	if (event.request.method === 'OPTIONS') return apiPreflightResponse(event.request, API_ORIGINS);
	const response = await resolve(event);
	applyApiResponseHeaders(event.request, response, API_ORIGINS);
	return response;
};

// The map is public — there is no navigation gate. `authenticate` only installs
// the lazy resolver; the optional signed-in user (account menu, likes, saved
// diet) is resolved on demand, and the user-scoped remote functions guard
// themselves with `requireUser()`.
//
// `authenticate` runs before `localize` so the lazy `getSession` resolver is
// installed by the time resolveLocale's step 2 reads the signed-in user's saved
// locale from it (a signed-out request skips that read — the step is gated on a
// session cookie). `localize` then establishes the per-request Paraglide locale
// context around the app resolve. Both sit after `canonicalHost`, so a 301'd host
// skips the auth + locale work entirely.
// `apiCors` sits innermost (after authenticate, so `locals.getSession` — the
// bearer resolver for app requests — is installed before an /api/v1 route reads
// it, and after localize so a JSON error string still resolves in the caller's
// locale). securityHeaders stays outermost so its browser headers also land on
// the /api/v1 CORS/preflight responses.
export const handle = sequence(securityHeaders, canonicalHost, authenticate, localize, apiCors);
