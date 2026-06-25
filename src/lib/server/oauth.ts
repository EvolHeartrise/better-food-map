// Google OAuth client (via Arctic) and the constants shared by the /auth routes.
// Arctic handles the protocol bits — building the authorization URL with PKCE and
// state, and exchanging the code for tokens — and works on Cloudflare Workers with
// no polyfill. Secrets come from the request's `platform.env`, so the client is
// built per-request rather than as a module singleton.
import { Google } from 'arctic';
import type { RequestEvent } from '@sveltejs/kit';

/** OAuth scopes we request: identity + basic profile + email. */
export const GOOGLE_SCOPES = ['openid', 'profile', 'email'];

/** Short-lived cookies holding the in-flight `state` and PKCE verifier. */
export const STATE_COOKIE = 'google_oauth_state';
export const CODE_VERIFIER_COOKIE = 'google_code_verifier';

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
