import { query, command, getRequestEvent } from '$app/server';
import { requireDb, currentUser } from '$lib/server/context';
import { type User } from '$lib/server/db';
import {
	LEGACY_SESSION_COOKIE,
	SESSION_COOKIE,
	clearSessionCookie,
	invalidateSessionToken
} from '$lib/server/auth';

/**
 * The signed-in user for the current request, or null. Backs the account control
 * and gates the review/bookmark UI. Resolved via the hook's lazy
 * `locals.getSession()` — the request's one memoized session read, shared with
 * every other consumer.
 */
export const getCurrentUser = query((): Promise<User | null> => currentUser());

/** Signs out: invalidates the session row and clears the cookie. */
export const signOut = command(async () => {
	const { cookies } = getRequestEvent();
	// Fall back to the legacy unprefixed cookie so a not-yet-migrated session
	// still gets its row invalidated; clearSessionCookie deletes both names.
	const token = cookies.get(SESSION_COOKIE) ?? cookies.get(LEGACY_SESSION_COOKIE);
	if (token) await invalidateSessionToken(requireDb(), token);
	clearSessionCookie(cookies);
});
