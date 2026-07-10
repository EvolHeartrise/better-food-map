// Completes the Google OAuth flow: verify the `state`/PKCE cookies, exchange the
// code for tokens, read the ID-token profile claims, upsert the user, open a
// session, and redirect home. Any tampering or a failed exchange returns a plain
// 400 rather than leaking detail.
import { decodeIdToken } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import { error, redirect } from '@sveltejs/kit';
import {
	createGoogleClient,
	STATE_COOKIE,
	CODE_VERIFIER_COOKIE,
	REDIRECT_COOKIE,
	APP_CLIENT_COOKIE,
	APP_CLIENT_VALUE,
	APP_CALLBACK_URL,
	type GoogleIdTokenClaims
} from '$lib/server/oauth';
import { upsertOAuthUser } from '$lib/server/db';
import { createUserSession, setSessionCookie } from '$lib/server/auth';
import { createAppAuthCode } from '$lib/server/app-auth';
import { safeInternalPath } from '$lib/redirect';
import { m } from '$lib/paraglide/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const db = event.platform?.env?.DB;
	if (!db) error(500, m.server_error_database_unavailable());

	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	const oauthError = event.url.searchParams.get('error');
	const storedState = event.cookies.get(STATE_COOKIE) ?? null;
	const codeVerifier = event.cookies.get(CODE_VERIFIER_COOKIE) ?? null;
	// Where to land after sign-in (set by the login route from `?redirectTo`),
	// re-validated to a same-origin path; defaults to the map.
	const redirectTo = safeInternalPath(event.cookies.get(REDIRECT_COOKIE));
	// Was this round trip started by the mobile app (`?client=app` on the login
	// route)? If so we hand back a one-time code via the custom scheme instead of a
	// browser session cookie.
	const isApp = event.cookies.get(APP_CLIENT_COOKIE) === APP_CLIENT_VALUE;

	// Clear the in-flight cookies regardless of outcome so a stale state can't linger.
	event.cookies.delete(STATE_COOKIE, { path: '/' });
	event.cookies.delete(CODE_VERIFIER_COOKIE, { path: '/' });
	event.cookies.delete(REDIRECT_COOKIE, { path: '/' });
	event.cookies.delete(APP_CLIENT_COOKIE, { path: '/' });

	// The user declined consent (or Google reported an error): Google sends back
	// `?error=…` and no code. That's a normal cancellation, not a fault — send them
	// back to the landing page rather than showing a 400 page.
	if (oauthError) redirect(302, '/');

	if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
		error(400, m.server_error_oauth_invalid_callback());
	}

	let tokens: OAuth2Tokens;
	try {
		tokens = await createGoogleClient(event).validateAuthorizationCode(code, codeVerifier);
	} catch {
		error(400, m.server_error_oauth_code_validation());
	}

	const claims = decodeIdToken(tokens.idToken()) as GoogleIdTokenClaims;
	if (!claims.sub) error(400, m.server_error_oauth_missing_subject());

	const user = await upsertOAuthUser(
		db,
		'google',
		claims.sub,
		{
			email: claims.email ?? null,
			email_verified: claims.email_verified ?? false,
			name: claims.name ?? null,
			picture: claims.picture ?? null
		},
		Date.now()
	);

	// Mobile app: do NOT set the browser session cookie (the app can't read it).
	// Mint a short-lived one-time code (only its hash is stored) and 303-redirect to
	// the app's custom scheme, which hands the code to the app to exchange for a
	// session token at POST /api/v1/auth/token. 303 so the browser issues a GET to
	// the custom-scheme URL. The raw code is a high-entropy opaque token, safe in
	// the URL for the seconds it lives.
	if (isApp) {
		const appCode = await createAppAuthCode(db, user.id, Date.now());
		redirect(303, `${APP_CALLBACK_URL}?code=${encodeURIComponent(appCode)}`);
	}

	const { token, session } = await createUserSession(db, user.id);
	setSessionCookie(event.cookies, token, session.expires_at);

	redirect(302, redirectTo);
};
