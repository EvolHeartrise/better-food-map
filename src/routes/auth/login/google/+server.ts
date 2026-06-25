// Starts the Google OAuth flow: mint a `state` + PKCE verifier, stash them in
// short-lived HttpOnly cookies, and redirect the browser to Google's consent
// screen. The matching callback (../../callback/google) verifies them.
import { generateState, generateCodeVerifier } from 'arctic';
import {
	createGoogleClient,
	GOOGLE_SCOPES,
	STATE_COOKIE,
	CODE_VERIFIER_COOKIE
} from '$lib/server/oauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const google = createGoogleClient(event);
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES);

	const cookieOptions = {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		maxAge: 60 * 10 // 10 minutes to complete the round trip
	};
	event.cookies.set(STATE_COOKIE, state, cookieOptions);
	event.cookies.set(CODE_VERIFIER_COOKIE, codeVerifier, cookieOptions);

	return new Response(null, { status: 302, headers: { location: url.toString() } });
};
