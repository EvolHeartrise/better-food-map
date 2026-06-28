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

// The map used to live under `/map` (behind a sign-in gate); it now sits at the root
// `/`. Permanently redirect old links so bookmarks and shared deep links keep working:
// `/map` → `/`, and a `/map/locations/<id>` detail link → `/locations/<id>` (the
// shallow-routing URL the root map page reads). The trailing path/query is preserved.
const legacyMapRedirect: Handle = async ({ event, resolve }) => {
	const { pathname, search } = event.url;
	if (pathname === '/map') {
		return new Response(null, { status: 301, headers: { location: `/${search}` } });
	}
	if (pathname.startsWith('/map/')) {
		return new Response(null, {
			status: 301,
			headers: { location: `${pathname.slice('/map'.length)}${search}` }
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

// The map is public — there is no navigation gate. `authenticate` still runs so an
// optional signed-in user (account menu, likes, saved diet) is resolved for every
// request; the user-scoped remote functions guard themselves with `requireUser()`.
export const handle = sequence(canonicalHost, legacyMapRedirect, authenticate);
