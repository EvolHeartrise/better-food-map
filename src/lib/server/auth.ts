// Session-cookie glue. This is APP-ONLY (it uses SvelteKit cookies and
// `$app/environment`) — the token/session logic itself lives in session.ts,
// which stays `$app`-free so bun test can exercise its expiry/refresh
// boundaries. Re-exported here so callers keep one import site.
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { hostCookieName } from './cookie-name';

export {
	SESSION_TTL_MS,
	parseBearerToken,
	sessionSourceFor,
	createUserSession,
	createLazySessionResolver,
	validateSessionToken,
	invalidateSessionToken,
	type SessionSource,
	type ResolvedSession,
	type SessionCookieSink,
	type SessionValidation
} from './session';

/**
 * Name of the cookie holding the opaque session token: `__Host-session` in
 * production (host-locked against subdomain cookie tossing — see
 * cookie-name.ts), plain `session` under `vite dev`.
 */
export const SESSION_COOKIE = hostCookieName('session', dev);

/**
 * The pre-`__Host-` cookie name, still arriving on requests from sessions
 * opened before the rename. Read as a fallback (and migrated to the prefixed
 * name) by the auth hook and sign-out so deployed users stay signed in; new
 * writes always use SESSION_COOKIE. Delete this fallback once the 30-day
 * session TTL has rolled over past the rename deploy.
 */
export const LEGACY_SESSION_COOKIE = 'session';

/**
 * Sets the session cookie: HttpOnly, Secure, SameSite=Lax, expiring with the
 * session. `Secure` is dropped under `vite dev` so the cookie still sets over
 * plain-HTTP `http://localhost`; production is always HTTPS.
 */
export function setSessionCookie(cookies: Cookies, token: string, expiresAt: number): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		expires: new Date(expiresAt)
	});
}

/**
 * Clears the session cookie — both the current name and, in production, the
 * legacy unprefixed one, so sign-out / an invalid token never leaves a stale
 * pre-rename cookie behind.
 */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
		cookies.delete(LEGACY_SESSION_COOKIE, { path: '/' });
	}
}
