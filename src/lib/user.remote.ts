import { query, command, getRequestEvent } from '$app/server';
import { requireDb, currentUser } from '$lib/server/context';
import { type User, type UserLikes } from '$lib/server/db';
import {
	LocationLikeSchema,
	ItemLikeSchema,
	likeLocation,
	likeItem,
	readLikesForCurrentUser
} from '$lib/server/likes';
import {
	LEGACY_SESSION_COOKIE,
	SESSION_COOKIE,
	clearSessionCookie,
	invalidateSessionToken
} from '$lib/server/auth';

/**
 * The signed-in user for the current request, or null. Backs the account control
 * and gates the like UI. Resolved via the hook's lazy `locals.getSession()` —
 * the request's one memoized session read, shared with every other consumer.
 */
export const getCurrentUser = query((): Promise<User | null> => currentUser());

/**
 * The location and item ids the current user has liked (newest first), or empty
 * lists when signed out. The map page seeds its optimistic like state from this.
 */
export const getLikes = query((): Promise<UserLikes> => readLikesForCurrentUser());

/** Likes or unlikes a location for the signed-in user. Shares its validation +
 *  write with the /api/v1 like endpoint (see $lib/server/likes). */
export const setLocationLiked = command(LocationLikeSchema, ({ locationId, liked }) =>
	likeLocation(locationId, liked)
);

/** Likes or unlikes a menu item for the signed-in user. Shares its validation +
 *  write with the /api/v1 like endpoint (see $lib/server/likes). */
export const setItemLiked = command(ItemLikeSchema, ({ itemId, liked }) => likeItem(itemId, liked));

/** Signs out: invalidates the session row and clears the cookie. */
export const signOut = command(async () => {
	const { cookies } = getRequestEvent();
	// Fall back to the legacy unprefixed cookie so a not-yet-migrated session
	// still gets its row invalidated; clearSessionCookie deletes both names.
	const token = cookies.get(SESSION_COOKIE) ?? cookies.get(LEGACY_SESSION_COOKIE);
	if (token) await invalidateSessionToken(requireDb(), token);
	clearSessionCookie(cookies);
});
