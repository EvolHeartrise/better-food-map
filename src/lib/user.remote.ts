import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { query, command, getRequestEvent } from '$app/server';
import { requireDb, currentUser, requireUser } from '$lib/server/context';
import {
	getUserLikes,
	setLocationLike,
	setItemLike,
	type User,
	type UserLikes
} from '$lib/server/db';
import { SESSION_COOKIE, clearSessionCookie, invalidateSessionToken } from '$lib/server/auth';

/**
 * The signed-in user for the current request, or null. Backs the account control
 * and gates the like UI. Reads `locals.user` (set by the session hook), so
 * it needs no database round-trip of its own.
 */
export const getCurrentUser = query((): Promise<User | null> => Promise.resolve(currentUser()));

/**
 * The location and item ids the current user has liked (newest first), or empty
 * lists when signed out. The map page seeds its optimistic like state from this.
 */
export const getLikes = query(async (): Promise<UserLikes> => {
	const user = currentUser();
	if (!user) return { locationIds: [], itemIds: [] };
	return getUserLikes(requireDb(), user.id);
});

/**
 * The id of a location or item to (un)like. Ids are UUIDs or short slugs, so
 * the length cap never bites a real id — it only keeps hostile payloads out of
 * the D1 query. Auth (`requireUser`) gates WHO can write; it says nothing about
 * the id, which arrives untrusted like every remote argument.
 */
const LikeIdSchema = v.pipe(v.string(), v.maxLength(128));

/**
 * Awaits a like write, converting a D1 FOREIGN KEY violation — the id doesn't
 * reference a real location/item — into a 400 rather than an unhandled 500.
 * That's the only client-causable failure of these INSERTs (a forged id, or a
 * stale one whose row was deleted mid-session), and D1 surfaces it only through
 * the error message, hence the case-insensitive substring match. Anything else
 * is a server fault and rethrows unchanged. The unlike path is a bare DELETE
 * that can't FK-fail, so it passes through here harmlessly.
 */
async function badRequestOnFkViolation(write: Promise<void>): Promise<void> {
	try {
		await write;
	} catch (e) {
		if (e instanceof Error && e.message.toUpperCase().includes('FOREIGN KEY')) {
			error(400, 'No such location or item.');
		}
		throw e;
	}
}

/** Likes or unlikes a location for the signed-in user. */
export const setLocationLiked = command(
	v.object({ locationId: LikeIdSchema, liked: v.boolean() }),
	async ({ locationId, liked }) => {
		const user = requireUser();
		await badRequestOnFkViolation(
			setLocationLike(requireDb(), user.id, locationId, liked, Date.now())
		);
	}
);

/** Likes or unlikes a menu item for the signed-in user. */
export const setItemLiked = command(
	v.object({ itemId: LikeIdSchema, liked: v.boolean() }),
	async ({ itemId, liked }) => {
		const user = requireUser();
		await badRequestOnFkViolation(setItemLike(requireDb(), user.id, itemId, liked, Date.now()));
	}
);

/** Signs out: invalidates the session row and clears the cookie. */
export const signOut = command(async () => {
	const { cookies } = getRequestEvent();
	const token = cookies.get(SESSION_COOKIE);
	if (token) await invalidateSessionToken(requireDb(), token);
	clearSessionCookie(cookies);
});
