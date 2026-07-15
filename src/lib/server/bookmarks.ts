// Shared bookmark write logic, factored out so the remote `command`s AND the
// /api/v1 bookmark endpoints call ONE implementation — the same validation schemas,
// the same auth guard, and the same FK-violation→400 mapping — rather than the
// mobile bridge re-deriving any of it. Mirrors the old likes.ts (migration 0029
// replaced the heart/like with a private bookmark + a rating/review). The
// `command`s and the endpoints are thin callers; this is where a bookmark happens.
import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { requireDb, currentUser, requireUser } from './context';
import { getUserBookmarks, setBookmark, type ReviewTarget, type UserBookmarks } from './db';

/**
 * The id of a location or item to (un)bookmark. Ids are UUIDs or short slugs, so the
 * length cap never bites a real id — it only keeps hostile payloads out of the D1
 * query. Auth (`requireUser`) gates WHO can write; it says nothing about the id,
 * which arrives untrusted like every remote/endpoint argument.
 */
export const TargetIdSchema = v.pipe(v.string(), v.maxLength(128));

/** Validated body of a location bookmark toggle (remote command arg and API JSON body). */
export const LocationBookmarkSchema = v.object({ locationId: TargetIdSchema, on: v.boolean() });
/** Validated body of an item bookmark toggle (remote command arg and API JSON body). */
export const ItemBookmarkSchema = v.object({ itemId: TargetIdSchema, on: v.boolean() });

/**
 * Awaits a write, converting a D1 FOREIGN KEY violation — an id that doesn't
 * reference a real location/item/review — into a 400 rather than an unhandled 500.
 * That's the only client-causable failure of these INSERTs (a forged id, or a stale
 * one whose row was deleted mid-session), and D1 surfaces it only through the error
 * message, hence the case-insensitive substring match. Anything else is a server
 * fault and rethrows unchanged. Shared by bookmarks and reviews.
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
 * The location and item ids the current user has bookmarked (newest first), or empty
 * lists when signed out. Backs both the `getBookmarks` remote query and
 * GET /api/v1/me/bookmarks.
 */
export async function readBookmarksForCurrentUser(): Promise<UserBookmarks> {
	const user = await currentUser();
	if (!user) return { locationIds: [], itemIds: [] };
	return getUserBookmarks(requireDb(), user.id);
}

/** Bookmarks or un-bookmarks a target for the signed-in user (401 when signed out). */
export async function bookmark(target: ReviewTarget, targetId: string, on: boolean): Promise<void> {
	const user = await requireUser();
	await badRequestOnFkViolation(
		setBookmark(requireDb(), target, user.id, targetId, on, Date.now())
	);
}
