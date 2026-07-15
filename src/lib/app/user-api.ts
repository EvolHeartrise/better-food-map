// App shim for `$lib/user.remote` (aliased in the Capacitor build). Same export
// surface the web components import, backed by the /api/v1 user endpoints.
import type { User } from '$lib/server/db';
import { apiGet, apiPost } from './api-client';
import { makeQuery } from './query-resource.svelte';
import { getBookmarks, getMyRatings } from './review-api';
import { getDiet } from './profile-api';
import { clearToken } from './token-store';

/** The signed-in user, or null (mirrors getCurrentUser). Refreshed by the auth flow. */
export const getCurrentUser = makeQuery(() =>
	apiGet<{ user: User | null }>('/api/v1/me').then((r) => r.user)
);

/**
 * Signs out (mirrors signOut): revokes the bearer session server-side, clears
 * the stored token, then refreshes the user-scoped resources so the UI resets.
 * The account menu reloads afterwards regardless, but refreshing keeps the
 * in-session state honest even if the reload is skipped.
 */
export async function signOut(): Promise<void> {
	try {
		await apiPost('/api/v1/auth/signout');
	} finally {
		await clearToken();
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
}
