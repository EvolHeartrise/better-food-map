// Remote functions for the review system: bookmarks, ratings/reviews, reports and
// (admin) moderation. Thin callers over the shared $lib/server/{bookmarks,reviews}
// implementations — the SAME validation + writes the /api/v1 review endpoints call,
// so the web app and the mobile bridge never diverge. See user.remote.ts for the
// account/sign-out functions this sits beside.
import { query, command } from '$app/server';
import type { UserBookmarks, ViewerRatings, VenueReviews } from '$lib/server/db';
import {
	LocationBookmarkSchema,
	ItemBookmarkSchema,
	bookmark,
	readBookmarksForCurrentUser
} from '$lib/server/bookmarks';
import {
	LocationReviewSchema,
	ItemReviewSchema,
	LocationTargetSchema,
	ItemTargetSchema,
	ReportSchema,
	LocationReviewsQuerySchema,
	ItemReviewsQuerySchema,
	saveReview,
	removeReview,
	report,
	readReviews,
	readViewerRatings
} from '$lib/server/reviews';

// ── Bookmarks ────────────────────────────────────────────────────────────────

/** The current user's bookmarked location + item ids (empty when signed out). Seeds
 *  the map page's optimistic bookmark state. */
export const getBookmarks = query((): Promise<UserBookmarks> => readBookmarksForCurrentUser());

/** Bookmarks/un-bookmarks a location for the signed-in user. Shares its validation +
 *  write with the /api/v1 endpoint (see $lib/server/bookmarks). */
export const setLocationBookmarked = command(LocationBookmarkSchema, ({ locationId, on }) =>
	bookmark('location', locationId, on)
);
/** Bookmarks/un-bookmarks a menu item for the signed-in user. */
export const setItemBookmarked = command(ItemBookmarkSchema, ({ itemId, on }) =>
	bookmark('item', itemId, on)
);

// ── Ratings / reviews ────────────────────────────────────────────────────────

/** The current user's own rating per location/item (empty when signed out). Seeds the
 *  map page so the user's own stars render on the map and menu. */
export const getMyRatings = query((): Promise<ViewerRatings> => readViewerRatings());

/** Upserts the signed-in user's rating (+ optional text) for a location. */
export const setLocationReview = command(LocationReviewSchema, ({ locationId, rating, body }) =>
	saveReview('location', locationId, rating, body)
);
/** Upserts the signed-in user's rating (+ optional text) for a menu item. */
export const setItemReview = command(ItemReviewSchema, ({ itemId, rating, body }) =>
	saveReview('item', itemId, rating, body)
);
/** Deletes the signed-in user's review of a location (un-star). */
export const clearLocationReview = command(LocationTargetSchema, ({ locationId }) =>
	removeReview('location', locationId)
);
/** Deletes the signed-in user's review of a menu item (un-star). */
export const clearItemReview = command(ItemTargetSchema, ({ itemId }) =>
	removeReview('item', itemId)
);

/** A page of a location's public reviews + the viewer's own review (for the panel). */
export const getLocationReviews = query(
	LocationReviewsQuerySchema,
	({ locationId, cursor }): Promise<VenueReviews> => readReviews('location', locationId, cursor)
);
/** A page of a menu item's public reviews + the viewer's own review. */
export const getItemReviews = query(
	ItemReviewsQuerySchema,
	({ itemId, cursor }): Promise<VenueReviews> => readReviews('item', itemId, cursor)
);

/** Reports a public location review; auto-hides it past the report threshold. */
export const reportLocationReview = command(ReportSchema, ({ reviewId, reason }) =>
	report('location', reviewId, reason)
);
/** Reports a public item review. */
export const reportItemReview = command(ReportSchema, ({ reviewId, reason }) =>
	report('item', reviewId, reason)
);

// Admin moderation (hide/un-hide, the reported queue) is NOT here: it is web-only
// and served by the guarded /admin/reviews route's +page.server.ts (load + form
// actions calling $lib/server/reviews directly), so the app build never has to
// stub it. Keeping it out of this aliased module is deliberate.
