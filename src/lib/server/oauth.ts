// Google OAuth client (via Arctic) and the constants shared by the /auth routes.
// Arctic handles the protocol bits — building the authorization URL with PKCE and
// state, and exchanging the code for tokens — and works on Cloudflare Workers with
// no polyfill. Secrets come from the request's `platform.env`, so the client is
// built per-request rather than as a module singleton.
import { Google } from 'arctic';
import type { RequestEvent } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { hostCookieName } from './cookie-name';

/** OAuth scopes we request: identity + basic profile + email. */
export const GOOGLE_SCOPES = ['openid', 'profile', 'email'];

/**
 * Short-lived cookies holding the in-flight `state` and PKCE verifier.
 * `__Host-`-prefixed in production (host-locked — see cookie-name.ts) so a
 * subdomain can't toss a shadowing state/verifier and steer the OAuth round
 * trip; unprefixed under `vite dev` where the required `Secure` is dropped.
 * These live only for the ~10-minute round trip, so no legacy-name fallback
 * is needed: a rename mid-flight just fails state validation once.
 */
export const STATE_COOKIE = hostCookieName('google_oauth_state', dev);
export const CODE_VERIFIER_COOKIE = hostCookieName('google_code_verifier', dev);

/**
 * Short-lived cookie holding where to send the user after a successful sign-in (a
 * validated same-origin path). Set by the login route from `?redirectTo`, read and
 * cleared by the callback. Stored server-side for the round trip rather than in the
 * OAuth `state` so it can't influence state validation.
 */
export const REDIRECT_COOKIE = hostCookieName('oauth_redirect', dev);

/**
 * Short-lived cookie recording that this OAuth round trip was started by the
 * MOBILE APP (login route hit with `?client=app`), so the callback hands the app a
 * one-time code via a custom-scheme redirect instead of setting a browser session
 * cookie the app can't read (see the callback and $lib/server/app-auth). Its VALUE
 * is the app's validated `state` (see `isValidAppState`) — a well-formed value
 * both marks the app round trip AND carries the state the callback reflects to the
 * app, so only the app instance that started sign-in can redeem the code; an empty
 * value means a plain browser sign-in. Same `__Host-`-in-prod / round-trip-lifetime
 * shape as REDIRECT_COOKIE, and it's always cleared by the callback, so no
 * legacy-name fallback is needed.
 */
export const APP_CLIENT_COOKIE = hostCookieName('oauth_app_client', dev);

/** The `?client=` value on the login route that marks a mobile-app round trip. */
export const APP_CLIENT_VALUE = 'app';

/**
 * The custom URL scheme the mobile app registers; the OAuth callback 303-redirects
 * to `${APP_CALLBACK_URL}?code=<one-time code>` so the OS hands the code back to
 * the app, which exchanges it at POST /api/v1/auth/token.
 */
export const APP_CALLBACK_URL = 'betterfoodmaps://auth/callback';

/** The path Google redirects back to; must match a URI registered in the console. */
export const CALLBACK_PATH = '/auth/callback/google';

/**
 * Builds the Google client for this request. The redirect URI is derived from the
 * request origin, so it is correct for both local dev and production (register
 * both in the Google Cloud console). Throws a clear error when the credentials
 * aren't configured (see `.dev.vars.example` / `wrangler secret put`).
 */
export function createGoogleClient(event: RequestEvent): Google {
	const env = event.platform?.env;
	const clientId = env?.GOOGLE_CLIENT_ID;
	const clientSecret = env?.GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error(
			'Google OAuth is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET ' +
				'(via `wrangler secret put` in production, or .dev.vars locally — see .dev.vars.example).'
		);
	}
	return new Google(clientId, clientSecret, `${event.url.origin}${CALLBACK_PATH}`);
}

/** The Google ID-token claims we read after a successful exchange. */
export interface GoogleIdTokenClaims {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
}
