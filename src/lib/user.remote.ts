import * as v from 'valibot';
import { query, command, getRequestEvent } from '$app/server';
import { requireDb, currentUser, requireUser } from '$lib/server/context';
import {
	getUserLikes,
	setLocationLike,
	setItemLike,
	logSearch as logSearchToDb,
	getSearchHistory,
	type User,
	type UserLikes,
	type SearchHistoryEntry
} from '$lib/server/db';
import { SESSION_COOKIE, clearSessionCookie, invalidateSessionToken } from '$lib/server/auth';

/**
 * The signed-in user for the current request, or null. Backs the account control
 * and gates the like/history UI. Reads `locals.user` (set by the session hook), so
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

/** Likes or unlikes a location for the signed-in user. */
export const setLocationLiked = command(
	v.object({ locationId: v.string(), liked: v.boolean() }),
	async ({ locationId, liked }) => {
		const user = requireUser();
		await setLocationLike(requireDb(), user.id, locationId, liked, Date.now());
	}
);

/** Likes or unlikes a menu item for the signed-in user. */
export const setItemLiked = command(
	v.object({ itemId: v.string(), liked: v.boolean() }),
	async ({ itemId, liked }) => {
		const user = requireUser();
		await setItemLike(requireDb(), user.id, itemId, liked, Date.now());
	}
);

// A tag as carried by the client filters. The full {id, name, tag_type} is stored
// so a re-applied search rehydrates the pickers without a lookup.
const TagSchema = v.object({
	id: v.string(),
	name: v.string(),
	tag_type: v.picklist(['dietary', 'course', 'ingredient'])
});

const SearchSchema = v.object({
	place: v.string(),
	item: v.string(),
	included: v.array(TagSchema),
	excluded: v.array(TagSchema)
});

/**
 * Auto-logs a search to the signed-in user's history (uncapped — see migration
 * 0007). A no-op when signed out, so the client can fire it without first checking
 * auth; it's best-effort telemetry, not a user-visible action.
 */
export const logSearch = command(SearchSchema, async (entry) => {
	const user = currentUser();
	if (!user) return;
	await logSearchToDb(requireDb(), {
		id: crypto.randomUUID(),
		userId: user.id,
		place: entry.place,
		item: entry.item,
		included: entry.included,
		excluded: entry.excluded,
		createdAt: Date.now()
	});
});

/** The signed-in user's most recent searches (newest first), or empty when signed out. */
export const getRecentSearches = query(async (): Promise<SearchHistoryEntry[]> => {
	const user = currentUser();
	if (!user) return [];
	return getSearchHistory(requireDb(), user.id);
});

/** Signs out: invalidates the session row and clears the cookie. */
export const signOut = command(async () => {
	const { cookies } = getRequestEvent();
	const token = cookies.get(SESSION_COOKIE);
	if (token) await invalidateSessionToken(requireDb(), token);
	clearSessionCookie(cookies);
});
