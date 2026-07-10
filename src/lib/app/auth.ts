// The Capacitor client's auth: system-browser OAuth + custom-scheme deep-link
// token exchange. Imports @capacitor/* — MUST only ever be reached in the app
// build (behind the $lib/app aliases and IS_APP / __IS_APP__ gates); never let
// it into the web bundle.
//
// Flow:
//   1. signIn() opens the SYSTEM browser (not the WebView) at the server's
//      Google login with `?client=app`.
//   2. After Google, the server 303-redirects to
//      `betterfoodmaps://auth/callback?code=<one-time code>`.
//   3. The OS hands that deep link to the app; handleAppUrlOpen() catches it,
//      POSTs the code to /api/v1/auth/token, stores the returned bearer token,
//      closes the in-app browser, and refreshes the user-scoped resources.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import type { PluginListenerHandle } from '@capacitor/core';
import { goto } from '$app/navigation';
import type { User } from '$lib/server/db';
import { API_ORIGIN } from './platform';
import { apiPost } from './api-client';
import { setToken } from './token-store';
import { getCurrentUser, getLikes } from './user-api';
import { getDiet } from './profile-api';

const CALLBACK_SCHEME = 'betterfoodmaps:';
const WEB_ORIGIN = 'https://betterfoodmaps.com';

/** Opens the system browser at the server's Google sign-in for the app client. */
export async function signIn(): Promise<void> {
	await Browser.open({ url: `${API_ORIGIN}/auth/login/google?client=app` });
}

/** Re-pull the user-scoped resources after a session change. */
function refreshSession(): void {
	void getCurrentUser()
		.refresh()
		.catch(() => {});
	void getLikes()
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
		const code = url.searchParams.get('code');
		if (code) {
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
