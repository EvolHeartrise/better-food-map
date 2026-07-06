// Session-cookie glue. This is APP-ONLY (it uses SvelteKit cookies and
// `$app/environment`) — the token/session logic itself lives in session.ts,
// which stays `$app`-free so bun test can exercise its expiry/refresh
// boundaries. Re-exported here so callers keep one import site.
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';

export {
	SESSION_TTL_MS,
	generateSessionToken,
	createUserSession,
	createLazySessionResolver,
	validateSessionToken,
	invalidateSessionToken,
	type ResolvedSession,
	type SessionCookieSink,
	type SessionValidation
} from './session';

/** Name of the cookie holding the opaque session token. */
export const SESSION_COOKIE = 'session';

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

/** Clears the session cookie. */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
