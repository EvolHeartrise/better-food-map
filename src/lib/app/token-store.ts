// The Capacitor client's bearer-token store: an in-memory cache backed by
// @capacitor/preferences (native key/value; survives app restarts).
//
// Split out from both api-client.ts (which READS the token on every request,
// synchronously) and auth.ts (which WRITES it on sign-in/out) so the two never
// form an import cycle. The persisted token is loaded LAZILY and memoized via
// `ensureLoaded()`, which api-client awaits before every request — so the very
// first API call (e.g. the map page's getCurrentUser/getDiet on mount) already
// carries the stored token, and a signed-in user is never briefly mis-seeded as
// signed-out on a cold start. The load is triggered on first use (never at
// module top level), so importing this module during the static build's
// fallback SSR runs no Capacitor plugin code.
import { Preferences } from '@capacitor/preferences';

const TOKEN_KEY = 'bfm_session_token';

let mem: string | null = null;
let loadPromise: Promise<void> | null = null;

/**
 * Ensures the persisted token has been read into memory exactly once. Every API
 * request awaits this first, so `getToken()` is authoritative by the time a
 * request is built. A read failure resolves to "signed out" rather than hanging.
 */
export function ensureLoaded(): Promise<void> {
	loadPromise ??= Preferences.get({ key: TOKEN_KEY })
		.then(({ value }) => {
			mem = value ?? null;
		})
		.catch(() => {
			mem = null;
		});
	return loadPromise;
}

/** The current bearer token (in-memory), or null when signed out. */
export function getToken(): string | null {
	return mem;
}

/** Persists a freshly minted token (sign-in / token exchange). */
export async function setToken(token: string): Promise<void> {
	mem = token;
	await Preferences.set({ key: TOKEN_KEY, value: token });
}

/** Clears the token (sign-out) from memory and storage. */
export async function clearToken(): Promise<void> {
	mem = null;
	await Preferences.remove({ key: TOKEN_KEY });
}
