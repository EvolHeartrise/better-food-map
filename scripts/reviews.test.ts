/// <reference types="bun-types" />
// Exercises the reviews DB layer (migration 0029): the three independent user
// actions on a venue OR a menu item — a private BOOKMARK, a 1..5 RATING with an
// optional public review body, and a moderation REPORT that auto-hides once
// enough distinct users flag it. All run against the real migration schema via
// the in-memory D1Like adapter, so the actual upsert / keyset-pagination /
// auto-hide SQL is what's under test. Rich pagination + moderation coverage sits
// on the LOCATION target; the ITEM target gets basic round-trips (its tables are
// the same shape, keyed on item_id).

import { test, expect } from 'bun:test';
import {
	setBookmark,
	getUserBookmarks,
	setReview,
	clearReview,
	getViewerRatings,
	getReviews,
	reportReview,
	setReviewHidden,
	getModerationReviews,
	getLocationMapData,
	REVIEW_AUTO_HIDE_THRESHOLD
} from '../src/lib/server/db';
import { insertLocations, insertFoods, type LocationInsert } from '../src/lib/server/db-write';
import { freshDb } from './test-d1';

/** A complete-address venue with sensible defaults; override per test. */
function venue(over: Partial<LocationInsert> & { name: string }): LocationInsert {
	return {
		category: 'restaurant',
		latitude: 49.2,
		longitude: -123.1,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

/** Inserts a bare users row (the FK target every review/bookmark/report needs). */
async function mkUser(db: ReturnType<typeof freshDb>, id: string): Promise<void> {
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind(id)
		.run();
}

// ── Bookmarks ────────────────────────────────────────────────────────────────

// A bookmark is a private saved-list toggle on either target. getUserBookmarks
// returns both id lists newest-first; a double-set is idempotent (INSERT OR
// IGNORE — one row) and un-bookmarking (on=false) removes it.
test('bookmarks round-trip on both targets: newest-first, idempotent, and removable', async () => {
	const db = freshDb();
	const [locA, locB] = await insertLocations(db, [
		venue({ name: 'Loc A', latitude: 49.2, longitude: -123.1 }),
		venue({ name: 'Loc B', latitude: 49.21, longitude: -123.11 })
	]);
	const [itemId] = await insertFoods(db, [{ location_id: locA, item_name: 'Soup', price: 5 }]);
	await mkUser(db, 'u1');

	// Save loc A (t=100), an item (t=150), then loc B later (t=200).
	await setBookmark(db, 'location', 'u1', locA, true, 100);
	await setBookmark(db, 'item', 'u1', itemId, true, 150);
	await setBookmark(db, 'location', 'u1', locB, true, 200);

	// Newest-first: loc B (t=200) precedes loc A (t=100); the item is on its own list.
	const saved = await getUserBookmarks(db, 'u1');
	expect(saved.locationIds).toEqual([locB, locA]);
	expect(saved.itemIds).toEqual([itemId]);

	// Idempotent: re-saving loc A (even at a later t) leaves exactly one row, so the
	// list is unchanged — INSERT OR IGNORE keeps the original created_at ordering.
	await setBookmark(db, 'location', 'u1', locA, true, 999);
	expect((await getUserBookmarks(db, 'u1')).locationIds).toEqual([locB, locA]);

	// Un-bookmark removes just that target; the rest survive.
	await setBookmark(db, 'location', 'u1', locB, false, 300);
	await setBookmark(db, 'item', 'u1', itemId, false, 300);
	const after = await getUserBookmarks(db, 'u1');
	expect(after.locationIds).toEqual([locA]);
	expect(after.itemIds).toEqual([]);
});

// ── Reviews: the three-valued body ───────────────────────────────────────────

// The most load-bearing behavior: `body` is three-valued on upsert. A string sets
// the text; `undefined` (a bare star tap) must PRESERVE an existing review's text
// while still updating the rating; `null` clears the text but keeps the rating.
// The upsert keeps the same row (id + created_at) via UNIQUE(user_id, location_id).
test('setReview body is three-valued: undefined preserves text, null clears it, rating always updates', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Reviewed Diner' })]);
	await mkUser(db, 'author');

	// 1) Write a full review (rating + text).
	await setReview(db, 'location', 'rev1', 'author', locId, 4, 'Great food', 100);
	let own = (await getReviews(db, 'location', locId, 'author', 10)).own;
	expect(own).toMatchObject({
		id: 'rev1',
		rating: 4,
		body: 'Great food',
		created_at: 100
	});

	// 2) A bare star tap (body === undefined) with a NEW rating and a would-be new id:
	//    the row is the SAME (id + created_at preserved), the rating updates, and the
	//    text is left untouched. `updated_at` moves to the new `now`.
	await setReview(db, 'location', 'rev-ignored', 'author', locId, 5, undefined, 200);
	own = (await getReviews(db, 'location', locId, 'author', 10)).own;
	expect(own).toMatchObject({
		id: 'rev1',
		rating: 5,
		body: 'Great food',
		created_at: 100,
		updated_at: 200
	});

	// 3) body === null clears the text but keeps (updates) the rating — a bare rating.
	await setReview(db, 'location', 'rev1', 'author', locId, 3, null, 300);
	own = (await getReviews(db, 'location', locId, 'author', 10)).own;
	expect(own?.rating).toBe(3);
	expect(own?.body).toBeNull();
});

// On a brand-new row (no conflict) `undefined` inserts NULL — a star with no text.
test('setReview on a new row with body=undefined inserts a bare rating (null body)', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Bare Diner' })]);
	await mkUser(db, 'u1');
	await setReview(db, 'location', 'rev1', 'u1', locId, 4, undefined, 100);
	const own = (await getReviews(db, 'location', locId, 'u1', 10)).own;
	expect(own).toMatchObject({ id: 'rev1', rating: 4 });
	expect(own?.body).toBeNull();
});

// clearReview deletes the whole row (un-starring drops rating + any text), so the
// viewer no longer has an own review and getViewerRatings loses the entry.
test('clearReview deletes the row entirely', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Cleared Diner' })]);
	await mkUser(db, 'u1');
	await setReview(db, 'location', 'rev1', 'u1', locId, 5, 'Loved it', 100);
	expect((await getViewerRatings(db, 'u1')).locations[locId]).toBe(5);

	await clearReview(db, 'location', 'u1', locId);
	expect((await getReviews(db, 'location', locId, 'u1', 10)).own).toBeNull();
	expect((await getViewerRatings(db, 'u1')).locations[locId]).toBeUndefined();
});

// getViewerRatings returns the user's own star per target across BOTH families,
// keyed by target id — the "your N★" pre-fill for the map and the menu.
test('getViewerRatings returns the viewer own rating per location and item', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Rated Diner' })]);
	const [itemId] = await insertFoods(db, [{ location_id: locId, item_name: 'Ramen', price: 12 }]);
	await mkUser(db, 'u1');
	await setReview(db, 'location', 'rl1', 'u1', locId, 4, null, 100);
	await setReview(db, 'item', 'ri1', 'u1', itemId, 2, null, 100);

	const ratings = await getViewerRatings(db, 'u1');
	expect(ratings.locations).toEqual({ [locId]: 4 });
	expect(ratings.items).toEqual({ [itemId]: 2 });
});

// A basic item-target review round-trip: the item tables mirror the location ones,
// so setReview / getViewerRatings / getReviews resolve on item_id just the same.
test('item-target reviews round-trip through the item_reviews tables', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Item Diner' })]);
	const [itemId] = await insertFoods(db, [{ location_id: locId, item_name: 'Tacos', price: 8 }]);
	await mkUser(db, 'author');
	await mkUser(db, 'viewer');
	// A public review by `author`, read by a different `viewer`.
	await setReview(db, 'item', 'ir1', 'author', itemId, 5, 'Best tacos', 100);
	const res = await getReviews(db, 'item', itemId, 'viewer', 10);
	expect(res.summary).toEqual({ count: 1, average: 5 });
	expect(res.reviews.map((r) => r.id)).toEqual(['ir1']);
	expect(res.reviews[0].body).toBe('Best tacos');
	expect(res.own).toBeNull(); // the viewer hasn't reviewed it
});

// ── getReviews: aggregate, public list, own, hidden ──────────────────────────

// The aggregate counts every NON-hidden review (bare ratings included); the public
// list carries only reviews with text that aren't hidden AND excludes the viewer's
// own; `own` surfaces the viewer's row separately; a hidden review drops out of
// both the aggregate and the list.
test('getReviews: summary spans bare+text reviews, list is public-minus-own, hidden excluded', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Busy Diner' })]);
	for (const u of ['viewer', 'bareRater', 'publicAuthor', 'hiddenAuthor']) await mkUser(db, u);

	// viewer: a text review (their OWN — excluded from the public list).
	await setReview(db, 'location', 'rV', 'viewer', locId, 5, 'My own take', 100);
	// bareRater: a rating with no text — feeds the aggregate only.
	await setReview(db, 'location', 'rBare', 'bareRater', locId, 3, null, 110);
	// publicAuthor: a text review by someone else — the one public row the viewer sees.
	await setReview(db, 'location', 'rPub', 'publicAuthor', locId, 4, 'Solid spot', 120);
	// hiddenAuthor: a text review, then hidden by moderation — excluded everywhere.
	await setReview(db, 'location', 'rHid', 'hiddenAuthor', locId, 1, 'Terrible', 130);
	await setReviewHidden(db, 'location', 'rHid', 999, 'admin');

	const res = await getReviews(db, 'location', locId, 'viewer', 10);
	// Aggregate: viewer(5) + bare(3) + public(4) = 3 reviews, avg 4; hidden excluded.
	expect(res.summary).toEqual({ count: 3, average: 4 });
	// Public list: only the other author's TEXT review — bare (no text), viewer's own,
	// and the hidden one are all absent.
	expect(res.reviews.map((r) => r.id)).toEqual(['rPub']);
	// `own` is the viewer's own review, surfaced separately for the editor.
	expect(res.own).toMatchObject({ id: 'rV', rating: 5, body: 'My own take' });
});

// Keyset pagination: with N public reviews and limit L, page 1 is exactly L rows
// newest-first with a non-null cursor, and the follow-up page returns the rest
// with a null cursor. created_at varies per review for a stable total order.
test('getReviews paginates newest-first with a keyset cursor', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Popular Diner' })]);
	// Five public reviews from five users, created_at 100..500 → newest-first rl5..rl1.
	for (let k = 1; k <= 5; k++) {
		await mkUser(db, `u${k}`);
		await setReview(db, 'location', `rl${k}`, `u${k}`, locId, 4, `Review ${k}`, k * 100);
	}

	// Page 1 (limit 3, no viewer so none excluded): the three newest, cursor set.
	const page1 = await getReviews(db, 'location', locId, null, 3);
	expect(page1.reviews.map((r) => r.id)).toEqual(['rl5', 'rl4', 'rl3']);
	expect(page1.nextCursor).not.toBeNull();

	// Page 2 from the cursor: the remaining two, then the cursor is exhausted.
	const page2 = await getReviews(db, 'location', locId, null, 3, page1.nextCursor);
	expect(page2.reviews.map((r) => r.id)).toEqual(['rl2', 'rl1']);
	expect(page2.nextCursor).toBeNull();
});

// setReviewHidden hides (non-null) and un-hides (null); the effect is observable
// through getReviews — hidden drops from both the list and the aggregate, and
// un-hiding restores it.
test('setReviewHidden toggles a review in and out of getReviews', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Toggle Diner' })]);
	await mkUser(db, 'author');
	await setReview(db, 'location', 'rev1', 'author', locId, 4, 'Visible now', 100);

	// Visible baseline (viewer null so the author's own text review lists).
	expect((await getReviews(db, 'location', locId, null, 10)).reviews.map((r) => r.id)).toEqual([
		'rev1'
	]);

	// Hide it: gone from the list AND the aggregate.
	await setReviewHidden(db, 'location', 'rev1', 555, 'admin note');
	let res = await getReviews(db, 'location', locId, null, 10);
	expect(res.reviews).toEqual([]);
	expect(res.summary.count).toBe(0);

	// Un-hide (null): back in both.
	await setReviewHidden(db, 'location', 'rev1', null, null);
	res = await getReviews(db, 'location', locId, null, 10);
	expect(res.reviews.map((r) => r.id)).toEqual(['rev1']);
	expect(res.summary.count).toBe(1);
});

// ── Moderation: reports & auto-hide ──────────────────────────────────────────

// A report auto-hides a review only once REVIEW_AUTO_HIDE_THRESHOLD DISTINCT users
// have flagged it. Below the threshold it stays visible ({hidden:false}); the
// threshold-th distinct reporter flips it hidden ({hidden:true}) and it leaves
// getReviews. A single reporter reporting twice counts once (UNIQUE per reporter).
test('reportReview auto-hides only at the distinct-reporter threshold, idempotent per reporter', async () => {
	const db = freshDb();
	expect(REVIEW_AUTO_HIDE_THRESHOLD).toBe(3);
	const [locId] = await insertLocations(db, [venue({ name: 'Flagged Diner' })]);
	await mkUser(db, 'author');
	for (const u of ['r1', 'r2', 'r3']) await mkUser(db, u);
	await setReview(db, 'location', 'rev1', 'author', locId, 1, 'Spammy text', 100);

	// First distinct reporter — below threshold, stays visible.
	expect(await reportReview(db, 'location', 'rep1', 'rev1', 'r1', 'spam', 200)).toEqual({
		hidden: false
	});
	// Same reporter again (new report id) — idempotent, still one distinct reporter.
	expect(await reportReview(db, 'location', 'rep1b', 'rev1', 'r1', 'spam', 205)).toEqual({
		hidden: false
	});
	// Second distinct reporter — still below the threshold of 3.
	expect(await reportReview(db, 'location', 'rep2', 'rev1', 'r2', null, 210)).toEqual({
		hidden: false
	});
	// Still visible, and only TWO distinct reports counted despite r1 reporting twice.
	expect((await getReviews(db, 'location', locId, null, 10)).reviews.map((r) => r.id)).toEqual([
		'rev1'
	]);
	const beforeHide = await getModerationReviews(db, 'location', 10);
	expect(beforeHide.find((m) => m.id === 'rev1')?.report_count).toBe(2);

	// Third distinct reporter reaches the threshold → auto-hidden.
	expect(await reportReview(db, 'location', 'rep3', 'rev1', 'r3', null, 220)).toEqual({
		hidden: true
	});
	const res = await getReviews(db, 'location', locId, null, 10);
	expect(res.reviews).toEqual([]);
	expect(res.summary.count).toBe(0);
});

// A small explicit threshold auto-hides sooner — the override the tests / admin
// tooling can pass instead of the default constant.
test('reportReview honours a caller-supplied threshold', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Low Threshold Diner' })]);
	await mkUser(db, 'author');
	await mkUser(db, 'r1');
	await mkUser(db, 'r2');
	await setReview(db, 'location', 'rev1', 'author', locId, 2, 'Flag me', 100);

	// Threshold 2: first report keeps it, the second distinct reporter hides it.
	expect(await reportReview(db, 'location', 'rep1', 'rev1', 'r1', null, 200, 2)).toEqual({
		hidden: false
	});
	expect(await reportReview(db, 'location', 'rep2', 'rev1', 'r2', null, 210, 2)).toEqual({
		hidden: true
	});
	expect((await getReviews(db, 'location', locId, null, 10)).reviews).toEqual([]);
});

// The moderation queue surfaces every review that is hidden OR has ≥1 report, most-
// reported first, carrying its report_count and the target's name; a clean,
// un-reported, un-hidden review never appears.
test('getModerationReviews lists reported-or-hidden rows, most-reported first', async () => {
	const db = freshDb();
	const [l1, l2, l3, l4] = await insertLocations(db, [
		venue({ name: 'Alpha Diner', latitude: 49.2, longitude: -123.1 }),
		venue({ name: 'Beta Diner', latitude: 49.21, longitude: -123.11 }),
		venue({ name: 'Gamma Diner', latitude: 49.22, longitude: -123.12 }),
		venue({ name: 'Delta Diner', latitude: 49.23, longitude: -123.13 })
	]);
	for (const u of ['a1', 'a2', 'a3', 'a4', 'r1', 'r2']) await mkUser(db, u);

	// revA: two reports (visible, threshold not hit). revB: one report. revC: no
	// reports but manually hidden. revD: clean — must be absent.
	await setReview(db, 'location', 'revA', 'a1', l1, 2, 'A', 100);
	await setReview(db, 'location', 'revB', 'a2', l2, 3, 'B', 200);
	await setReview(db, 'location', 'revC', 'a3', l3, 4, 'C', 300);
	await setReview(db, 'location', 'revD', 'a4', l4, 5, 'D', 400);
	await reportReview(db, 'location', 'pA1', 'revA', 'r1', null, 500);
	await reportReview(db, 'location', 'pA2', 'revA', 'r2', null, 510);
	await reportReview(db, 'location', 'pB1', 'revB', 'r1', null, 520);
	await setReviewHidden(db, 'location', 'revC', 600, 'admin');

	const queue = await getModerationReviews(db, 'location', 10);
	// Ordered by report_count DESC: revA(2) → revB(1) → revC(0, hidden). revD absent.
	expect(queue.map((m) => m.id)).toEqual(['revA', 'revB', 'revC']);
	expect(queue.map((m) => m.report_count)).toEqual([2, 1, 0]);
	// target_name comes from the joined location.
	expect(queue.find((m) => m.id === 'revA')?.target_name).toBe('Alpha Diner');
	expect(queue.find((m) => m.id === 'revC')?.hidden_at).toBe(600);
	expect(queue.some((m) => m.id === 'revD')).toBe(false);
});

// ── Score (locationScoreSql through the map read) ────────────────────────────

// The discoverability score a location ships (getLocationMapData) is the Bayesian
// prior alone (3.5 × 20 = 70) with no reviews or bookmarks, and rises once a rating
// lands (+100 volume term plus the average term).
test('getLocationMapData score is the empty-prior 70, and a rating raises it', async () => {
	const db = freshDb();
	const [locId] = await insertLocations(db, [venue({ name: 'Score Diner' })]);
	// No reviews, no bookmarks: the prior term only.
	expect((await getLocationMapData(db, locId)).locations[0].score).toBe(70);

	// Adding a rating lifts the score above the empty prior.
	await mkUser(db, 'u1');
	await setReview(db, 'location', 'rev1', 'u1', locId, 5, null, 100);
	expect((await getLocationMapData(db, locId)).locations[0].score).toBeGreaterThan(70);
});
