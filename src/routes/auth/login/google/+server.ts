// Starts the Google OAuth flow: mint a `state` + PKCE verifier, stash them in
// short-lived HttpOnly cookies, and redirect the browser to Google's consent
// screen. The matching callback (../../callback/google) verifies them.
import { generateState, generateCodeVerifier } from 'arctic';
import { dev } from '$app/environment';
import {
	createGoogleClient,
	GOOGLE_SCOPES,
	STATE_COOKIE,
	CODE_VERIFIER_COOKIE,
	REDIRECT_COOKIE,
	APP_CLIENT_COOKIE,
	APP_CLIENT_VALUE
} from '$lib/server/oauth';
import { isValidAppState } from '$lib/server/app-auth';
import { safeInternalPath } from '$lib/redirect';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const google = createGoogleClient(event);
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES);

	const cookieOptions = {
		path: '/',
		httpOnly: true,
		// Dropped under `vite dev` so the cookie sets over plain-HTTP localhost.
		secure: !dev,
		sameSite: 'lax' as const,
		maxAge: 60 * 10 // 10 minutes to complete the round trip
	};
	event.cookies.set(STATE_COOKIE, state, cookieOptions);
	event.cookies.set(CODE_VERIFIER_COOKIE, codeVerifier, cookieOptions);
	// Remember where to return after sign-in (validated to a same-origin path); the
	// callback reads this back. Always set so a stale value from a prior attempt can't
	// linger and hijack a later, plain sign-in.
	event.cookies.set(
		REDIRECT_COOKIE,
		safeInternalPath(event.url.searchParams.get('redirectTo')),
		cookieOptions
	);
	// Mobile-app round trip (`?client=app`): mark it so the callback hands the app a
	// one-time code via the custom-scheme redirect instead of a browser session
	// cookie. The app also passes its own high-entropy `state`, which we store AS the
	// cookie value (validated to a strict hex charset first) and the callback reflects
	// on the custom-scheme redirect — so only the app instance that started sign-in
	// can redeem the resulting code (login-CSRF / session-fixation defense). A missing
	// or malformed state degrades to a plain browser sign-in (empty value → no app
	// hand-off). Written UNCONDITIONALLY with the same lifetime as the others so a
	// stale value from a prior sign-in can never linger and misroute this one.
	const isApp = event.url.searchParams.get('client') === APP_CLIENT_VALUE;
	const stateParam = event.url.searchParams.get('state');
	const appState = isApp && isValidAppState(stateParam) ? stateParam : '';
	event.cookies.set(APP_CLIENT_COOKIE, appState, cookieOptions);

	return new Response(null, { status: 302, headers: { location: url.toString() } });
};
