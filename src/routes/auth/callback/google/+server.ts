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
	type GoogleIdTokenClaims
} from '$lib/server/oauth';
import { upsertOAuthUser } from '$lib/server/db';
import { createUserSession, setSessionCookie } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const db = event.platform?.env?.DB;
	if (!db) error(500, 'Database unavailable.');

	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	const oauthError = event.url.searchParams.get('error');
	const storedState = event.cookies.get(STATE_COOKIE) ?? null;
	const codeVerifier = event.cookies.get(CODE_VERIFIER_COOKIE) ?? null;

	// Clear the in-flight cookies regardless of outcome so a stale state can't linger.
	event.cookies.delete(STATE_COOKIE, { path: '/' });
	event.cookies.delete(CODE_VERIFIER_COOKIE, { path: '/' });

	// The user declined consent (or Google reported an error): Google sends back
	// `?error=…` and no code. That's a normal cancellation, not a fault — send them
	// back to the map rather than showing a 400 page.
	if (oauthError) redirect(302, '/');

	if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
		error(400, 'Invalid OAuth callback.');
	}

	let tokens: OAuth2Tokens;
	try {
		tokens = await createGoogleClient(event).validateAuthorizationCode(code, codeVerifier);
	} catch {
		error(400, 'Failed to validate the authorization code.');
	}

	const claims = decodeIdToken(tokens.idToken()) as GoogleIdTokenClaims;
	if (!claims.sub) error(400, 'Google response was missing the subject claim.');

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

	const { token, session } = await createUserSession(db, user.id);
	setSessionCookie(event.cookies, token, session.expires_at);

	redirect(302, '/');
};
