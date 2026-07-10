// App shim for `$lib/locale.remote` (aliased in the Capacitor build). Mirrors
// setLocale's D1 write via PUT /api/v1/me/locale.
//
// The remote setLocale does two things: write the preference COOKIE (this
// browser's active pick) and, when signed in, write D1 (cross-device). The app
// is cookieless and resolves its UI language from the DEVICE (navigator, see
// hooks.client.ts) — there is no per-app language override — so the cookie half
// is meaningless here. What remains worth doing is the signed-in D1 write, so a
// user's pick still follows them to the WEB app. For a signed-out app user this
// is a no-op (nothing to persist). See docs/mobile.md: the in-app UI language
// tracks the device setting, so the picker's visible effect in-app is limited.
import type { Locale } from '$lib/paraglide/runtime';
import { apiPut } from './api-client';
import { getToken } from './token-store';

export async function setLocale(locale: Locale): Promise<void> {
	if (!getToken()) return;
	await apiPut('/api/v1/me/locale', { locale });
}
