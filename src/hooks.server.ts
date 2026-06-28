import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	SESSION_COOKIE,
	clearSessionCookie,
	setSessionCookie,
	validateSessionToken
} from '$lib/server/auth';

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

// The app itself lives under `/map` (the map page) and is reached only by signed-in
// users. `/map/locations/*` and legacy `/locations/*` are rerouted to the map page
// (see hooks.ts) but keep their real pathname here, so guarding these prefixes covers
// shared deep links too. Everything else — the landing page `/`, the `/auth/*` OAuth
// routes, static assets — stays public.
function isProtectedPath(pathname: string): boolean {
	return pathname === '/map' || pathname.startsWith('/map/') || pathname.startsWith('/locations/');
}

// Gate the app behind sign-in: an unauthenticated request for a protected path is
// redirected to the landing page, carrying the originally requested path+query in
// `redirectTo` so the OAuth flow can return the user there. This runs after
// `authenticate`, so `locals.user` is already resolved.
//
// This is only the navigation guard for real page loads; the actual data is protected
// independently by `requireUser()` in the remote functions. We must skip remote-
// function requests here: for those, `event.url` is the CALLING PAGE's URL (e.g.
// `/map`), not the remote endpoint's, so gating them would turn the clean 401 that
// `requireUser()` throws (say, after a session expires while the map is open) into a
// 302 that serves landing-page HTML to a `fetch` expecting data. `requireUser()` is
// the real defence for that case.
const requireAuth: Handle = async ({ event, resolve }) => {
	if (event.isRemoteRequest) return resolve(event);
	if (isProtectedPath(event.url.pathname) && !event.locals.user) {
		const redirectTo = event.url.pathname + event.url.search;
		return new Response(null, {
			status: 302,
			headers: { location: `/?redirectTo=${encodeURIComponent(redirectTo)}` }
		});
	}
	return resolve(event);
};

export const handle = sequence(canonicalHost, authenticate, requireAuth);
