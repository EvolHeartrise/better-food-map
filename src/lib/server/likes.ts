// Shared like/unlike write logic, factored out of user.remote.ts so the remote
// `command`s AND the /api/v1 like endpoints call ONE implementation — the same
// validation schemas, the same auth guard, and the same FK-violation→400 mapping
// — rather than the API route re-deriving any of it (the copy-paste the mobile
// bridge would otherwise invite). The `command`s and the endpoints are just thin
// callers; this is where a like actually happens.
import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { requireDb, currentUser, requireUser } from './context';
import { getUserLikes, setLocationLike, setItemLike, type UserLikes } from './db';

/**
 * The id of a location or item to (un)like. Ids are UUIDs or short slugs, so the
 * length cap never bites a real id — it only keeps hostile payloads out of the D1
 * query. Auth (`requireUser`) gates WHO can write; it says nothing about the id,
 * which arrives untrusted like every remote/endpoint argument.
 */
export const LikeIdSchema = v.pipe(v.string(), v.maxLength(128));

/** Validated body of a location like/unlike (remote command arg and API JSON body). */
export const LocationLikeSchema = v.object({ locationId: LikeIdSchema, liked: v.boolean() });
/** Validated body of an item like/unlike (remote command arg and API JSON body). */
export const ItemLikeSchema = v.object({ itemId: LikeIdSchema, liked: v.boolean() });

/**
 * Awaits a like write, converting a D1 FOREIGN KEY violation — the id doesn't
 * reference a real location/item — into a 400 rather than an unhandled 500. That's
 * the only client-causable failure of these INSERTs (a forged id, or a stale one
 * whose row was deleted mid-session), and D1 surfaces it only through the error
 * message, hence the case-insensitive substring match. Anything else is a server
 * fault and rethrows unchanged. The unlike path is a bare DELETE that can't
 * FK-fail, so it passes through here harmlessly.
 */
export async function badRequestOnFkViolation(write: Promise<void>): Promise<void> {
	try {
		await write;
	} catch (e) {
		if (e instanceof Error && e.message.toUpperCase().includes('FOREIGN KEY')) {
			error(400, m.server_error_no_location_or_item());
		}
		throw e;
	}
}

/**
 * The location and item ids the current user has liked (newest first), or empty
 * lists when signed out. Backs both `getLikes` (the remote query the map page
 * seeds its optimistic like state from) and GET /api/v1/me/likes.
 */
export async function readLikesForCurrentUser(): Promise<UserLikes> {
	const user = await currentUser();
	if (!user) return { locationIds: [], itemIds: [] };
	return getUserLikes(requireDb(), user.id);
}

/** Likes or unlikes a location for the signed-in user (401 when signed out). */
export async function likeLocation(locationId: string, liked: boolean): Promise<void> {
	const user = await requireUser();
	await badRequestOnFkViolation(
		setLocationLike(requireDb(), user.id, locationId, liked, Date.now())
	);
}

/** Likes or unlikes a menu item for the signed-in user (401 when signed out). */
export async function likeItem(itemId: string, liked: boolean): Promise<void> {
	const user = await requireUser();
	await badRequestOnFkViolation(setItemLike(requireDb(), user.id, itemId, liked, Date.now()));
}
