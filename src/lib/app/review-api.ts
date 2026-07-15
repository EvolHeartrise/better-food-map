// App shim for `$lib/review.remote` (aliased in the Capacitor build — see
// vite.config.ts). Same export surface the web components import, backed by the
// /api/v1 review endpoints that share the remote functions' schemas + handlers.
import type { UserBookmarks, ViewerRatings, VenueReviews } from '$lib/server/db';
import { apiGet, apiPost } from './api-client';
import { makeQuery, makeArgQuery } from './query-resource.svelte';

// ── Bookmarks ────────────────────────────────────────────────────────────────

/** The current user's bookmarked ids (mirrors getBookmarks). */
export const getBookmarks = makeQuery(() => apiGet<UserBookmarks>('/api/v1/me/bookmarks'));

/** Bookmark/un-bookmark a location (mirrors setLocationBookmarked). */
export function setLocationBookmarked(args: { locationId: string; on: boolean }): Promise<unknown> {
	return apiPost('/api/v1/bookmarks/location', args);
}
/** Bookmark/un-bookmark a menu item (mirrors setItemBookmarked). */
export function setItemBookmarked(args: { itemId: string; on: boolean }): Promise<unknown> {
	return apiPost('/api/v1/bookmarks/item', args);
}

// ── Ratings / reviews ────────────────────────────────────────────────────────

/** The current user's own ratings (mirrors getMyRatings). */
export const getMyRatings = makeQuery(() => apiGet<ViewerRatings>('/api/v1/me/ratings'));

/** Upsert a location review (mirrors setLocationReview). */
export function setLocationReview(args: {
	locationId: string;
	rating: number;
	body?: string;
}): Promise<unknown> {
	return apiPost('/api/v1/reviews/location', args);
}
/** Upsert an item review (mirrors setItemReview). */
export function setItemReview(args: {
	itemId: string;
	rating: number;
	body?: string;
}): Promise<unknown> {
	return apiPost('/api/v1/reviews/item', args);
}
/** Delete the caller's location review (mirrors clearLocationReview). */
export function clearLocationReview(args: { locationId: string }): Promise<unknown> {
	return apiPost('/api/v1/reviews/location/clear', args);
}
/** Delete the caller's item review (mirrors clearItemReview). */
export function clearItemReview(args: { itemId: string }): Promise<unknown> {
	return apiPost('/api/v1/reviews/item/clear', args);
}

/** A page of a location's reviews (mirrors getLocationReviews); deduped per (id, cursor). */
export const getLocationReviews = makeArgQuery((args: { locationId: string; cursor?: string }) =>
	apiGet<VenueReviews>(
		`/api/v1/locations/${encodeURIComponent(args.locationId)}/reviews` +
			(args.cursor ? `?cursor=${encodeURIComponent(args.cursor)}` : '')
	)
);
/** A page of a menu item's reviews (mirrors getItemReviews). */
export const getItemReviews = makeArgQuery((args: { itemId: string; cursor?: string }) =>
	apiGet<VenueReviews>(
		`/api/v1/items/${encodeURIComponent(args.itemId)}/reviews` +
			(args.cursor ? `?cursor=${encodeURIComponent(args.cursor)}` : '')
	)
);

/** Report a public location review (mirrors reportLocationReview). */
export function reportLocationReview(args: {
	reviewId: string;
	reason?: string;
}): Promise<unknown> {
	return apiPost('/api/v1/reviews/location/report', args);
}
/** Report a public item review (mirrors reportItemReview). */
export function reportItemReview(args: { reviewId: string; reason?: string }): Promise<unknown> {
	return apiPost('/api/v1/reviews/item/report', args);
}
