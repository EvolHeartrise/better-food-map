// The Capacitor client's auth: system-browser OAuth + custom-scheme deep-link
// token exchange. Imports @capacitor/* — MUST only ever be reached in the app
// build (behind the $lib/app aliases and IS_APP / __IS_APP__ gates); never let
// it into the web bundle.
//
// Flow:
//   1. signIn() generates a random `state`, persists it, and opens the SYSTEM
//      browser (not the WebView) at the server's Google login with
//      `?client=app&state=<state>`.
//   2. After Google, the server 303-redirects to
//      `betterfoodmaps://auth/callback?code=<one-time code>&state=<state>`,
//      reflecting the same state back.
//   3. The OS hands that deep link to the app; handleAppUrlOpen() catches it and,
//      ONLY when the reflected state matches the persisted one (so the code is
//      bound to the sign-in THIS app started), POSTs the code to
//      /api/v1/auth/token, stores the returned bearer token, closes the in-app
//      browser, and refreshes the user-scoped resources.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';
import type { PluginListenerHandle } from '@capacitor/core';
import { goto } from '$app/navigation';
import type { User } from '$lib/server/db';
import { API_ORIGIN } from './platform';
import { apiPost } from './api-client';
import { setToken } from './token-store';
import { getCurrentUser } from './user-api';
import { getBookmarks, getMyRatings } from './review-api';
import { getDiet } from './profile-api';

const CALLBACK_SCHEME = 'betterfoodmaps:';
const WEB_ORIGIN = 'https://betterfoodmaps.com';

// Preferences key holding the in-flight sign-in `state` — a random hex token that
// binds a sign-in round trip to THIS app instance. Persisted (not just in memory)
// so it survives an Android singleTask relaunch of the app while the system
// browser is in front during the OAuth round trip.
const SIGN_IN_STATE_KEY = 'bfm_signin_state';

/** A random 256-bit lowercase-hex token (matches the server's APP_STATE_PATTERN). */
function generateSignInState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens the system browser at the server's Google sign-in for the app client,
 * carrying a freshly-generated `state`. The state is PERSISTED before the browser
 * opens so the callback deep link can be matched against it even across an Android
 * relaunch — only a callback whose reflected state equals this one is redeemed.
 */
export async function signIn(): Promise<void> {
	const state = generateSignInState();
	await Preferences.set({ key: SIGN_IN_STATE_KEY, value: state });
	await Browser.open({ url: `${API_ORIGIN}/auth/login/google?client=app&state=${state}` });
}

/** Re-pull the user-scoped resources after a session change. */
function refreshSession(): void {
	void getCurrentUser()
		.refresh()
		.catch(() => {});
	void getBookmarks()
		.refresh()
		.catch(() => {});
	void getMyRatings()
		.refresh()
		.catch(() => {});
	void getDiet()
		.refresh()
		.catch(() => {});
}

/** Exchanges the one-time OAuth code for a bearer token and stores it. */
async function exchangeCode(code: string): Promise<void> {
	const { token } = await apiPost<{ token: string; expiresAt: number; user: User }>(
		'/api/v1/auth/token',
		{ code }
	);
	await setToken(token);
	refreshSession();
}

/**
 * Handles an inbound deep link. Two shapes:
 *   • the OAuth callback (`betterfoodmaps://auth/callback?code=…`) — exchange it;
 *   • a shared venue link (`https://betterfoodmaps.com/locations/…`) — client-
 *     navigate to the path so it opens inside the app rather than the browser.
 */
export async function handleAppUrlOpen(rawUrl: string): Promise<void> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}

	if (url.protocol === CALLBACK_SCHEME) {
		// Read and CLEAR the persisted sign-in state up front. A code may be redeemed
		// only inside the in-flight, self-initiated sign-in that stored this state, and
		// clearing it before the exchange means a code can never be redeemed twice or
		// outside such a sign-in (a replayed or attacker-supplied deep link).
		const expectedState = await Preferences.get({ key: SIGN_IN_STATE_KEY })
			.then(({ value }) => value)
			.catch(() => null);
		await Preferences.remove({ key: SIGN_IN_STATE_KEY }).catch(() => {});

		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		// Redeem ONLY when a sign-in is in flight (state stored) AND the callback's
		// state strictly matches it. No stored state, or a mismatch, is ignored — the
		// deep link is not one we initiated, so it can never sign us in.
		if (expectedState && code && state === expectedState) {
			try {
				await exchangeCode(code);
			} catch {
				// A bad/expired/replayed code is an opaque 400; nothing to do but
				// leave the user signed out. The in-app browser still closes below.
			}
		}
		await Browser.close().catch(() => {});
		return;
	}

	if (url.origin === WEB_ORIGIN && url.pathname.startsWith('/locations/')) {
		await goto(`${url.pathname}${url.search}`);
	}
}

/** Registers the appUrlOpen listener; returns a handle to remove it. */
export function registerDeepLinks(): Promise<PluginListenerHandle> {
	return App.addListener('appUrlOpen', (event) => {
		void handleAppUrlOpen(event.url);
	});
}
