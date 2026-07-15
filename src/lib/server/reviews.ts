// Shared review/rating + moderation write logic, factored out so the remote
// `command`s AND the /api/v1 review endpoints call ONE implementation — same
// schemas, same auth guards, same FK-violation→400 mapping. Mirrors bookmarks.ts.
// A review is one row per (user, target): the rating (1..5) is always set, the
// `body` text is optional. A bare rating (no text) is an anonymous aggregate signal;
// a rating WITH text is a public, attributed review (migration 0029).
import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { requireDb, currentUser, requireUser, requireAdmin } from './context';
import { badRequestOnFkViolation, TargetIdSchema } from './bookmarks';
import {
	setReview,
	clearReview,
	reportReview,
	setReviewHidden,
	getReviews,
	getViewerRatings,
	getModerationReviews,
	type ReviewTarget,
	type ViewerRatings,
	type VenueReviews,
	type ModerationReview
} from './db';

/** A star rating: an integer 1..5. */
export const RatingSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5));
/** Optional review prose. Trimmed; capped so a hostile payload can't bloat the row. */
export const BodySchema = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000)));
/** A short optional note on why a review was reported. */
export const ReasonSchema = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500)));

/** Upsert a location review (remote command arg + API JSON body). */
export const LocationReviewSchema = v.object({
	locationId: TargetIdSchema,
	rating: RatingSchema,
	body: BodySchema
});
/** Upsert an item review. */
export const ItemReviewSchema = v.object({
	itemId: TargetIdSchema,
	rating: RatingSchema,
	body: BodySchema
});
/** Clear (delete) the caller's review of a target. */
export const LocationTargetSchema = v.object({ locationId: TargetIdSchema });
export const ItemTargetSchema = v.object({ itemId: TargetIdSchema });
/** Report a review, or (admin) hide/un-hide it — keyed by the review's own id. */
export const ReportSchema = v.object({ reviewId: TargetIdSchema, reason: ReasonSchema });
export const ReviewIdSchema = v.object({ reviewId: TargetIdSchema });
/** Read a page of a target's reviews. `cursor` is the opaque keyset from the prior page. */
export const LocationReviewsQuerySchema = v.object({
	locationId: TargetIdSchema,
	cursor: v.optional(v.pipe(v.string(), v.maxLength(128)))
});
export const ItemReviewsQuerySchema = v.object({
	itemId: TargetIdSchema,
	cursor: v.optional(v.pipe(v.string(), v.maxLength(128)))
});

/** How many public reviews a single page returns. */
export const REVIEWS_PAGE_SIZE = 20;

/** Empty-or-whitespace body → null (a bare rating), else the trimmed text. */
function normalizeBody(body: string | undefined): string | null {
	const trimmed = body?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Upserts the signed-in user's review of a target (401 when signed out). `body` is
 * passed through three-valued to {@link setReview}: `undefined` (the field absent —
 * a bare star tap) PRESERVES any existing text; a provided string sets it, with
 * empty/whitespace collapsing to null (clears the text but keeps the rating).
 */
export async function saveReview(
	target: ReviewTarget,
	targetId: string,
	rating: number,
	body: string | undefined
): Promise<void> {
	const user = await requireUser();
	const nextBody = body === undefined ? undefined : normalizeBody(body);
	await badRequestOnFkViolation(
		setReview(
			requireDb(),
			target,
			crypto.randomUUID(),
			user.id,
			targetId,
			rating,
			nextBody,
			Date.now()
		)
	);
}

/** Deletes the signed-in user's review of a target (un-star). */
export async function removeReview(target: ReviewTarget, targetId: string): Promise<void> {
	const user = await requireUser();
	await clearReview(requireDb(), target, user.id, targetId);
}

/**
 * Records a report against a review for the signed-in user; auto-hides it once
 * enough distinct users have reported it. A bad `reviewId` (no such review) is a 400.
 */
export async function report(
	target: ReviewTarget,
	reviewId: string,
	reason: string | undefined
): Promise<{ hidden: boolean }> {
	const user = await requireUser();
	try {
		return await reportReview(
			requireDb(),
			target,
			crypto.randomUUID(),
			reviewId,
			user.id,
			normalizeBody(reason),
			Date.now()
		);
	} catch (e) {
		if (e instanceof Error && e.message.toUpperCase().includes('FOREIGN KEY')) {
			error(400, m.server_error_no_location_or_item());
		}
		throw e;
	}
}

/** A page of a target's public reviews + the viewer's own review (null viewer = signed out). */
export async function readReviews(
	target: ReviewTarget,
	targetId: string,
	cursor: string | undefined
): Promise<VenueReviews> {
	const user = await currentUser();
	return getReviews(requireDb(), target, targetId, user?.id ?? null, REVIEWS_PAGE_SIZE, cursor);
}

/** The signed-in user's own rating per target (empty when signed out). Seeds the page. */
export async function readViewerRatings(): Promise<ViewerRatings> {
	const user = await currentUser();
	if (!user) return { locations: {}, items: {} };
	return getViewerRatings(requireDb(), user.id);
}

// ── Admin (moderation) ───────────────────────────────────────────────────────

/** Admin: hides a review. */
export async function hideReview(target: ReviewTarget, reviewId: string): Promise<void> {
	await requireAdmin();
	await setReviewHidden(requireDb(), target, reviewId, Date.now(), 'admin');
}

/** Admin: un-hides a review (clears the hidden flag). */
export async function unhideReview(target: ReviewTarget, reviewId: string): Promise<void> {
	await requireAdmin();
	await setReviewHidden(requireDb(), target, reviewId, null, null);
}

/** Admin: the moderation queue (reported or hidden reviews) across both targets. */
export async function readModerationQueue(): Promise<{
	locations: ModerationReview[];
	items: ModerationReview[];
}> {
	await requireAdmin();
	const db = requireDb();
	const [locations, items] = await Promise.all([
		getModerationReviews(db, 'location', 200),
		getModerationReviews(db, 'item', 200)
	]);
	return { locations, items };
}
