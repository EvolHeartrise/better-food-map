// Optimistic rating state for the map page (companion to $lib/optimistic-queue).
//
// A star tap reflects instantly, layered as a pending value over the server's saved
// ratings, and reverts if its write fails. Unlike a bookmark (a boolean toggle —
// see $lib/bookmarks.svelte), a rating carries a VALUE (1..5, or 0 = none), so the
// pending overlay maps id → number and the queue's `send` closes over that value.
//
// A bare star tap sets ONLY the rating: the upsert command omits `body`, so the
// server preserves any review text the user already wrote (a tap must never wipe a
// review). Rating 0 clears the review entirely (rating + text) via the clear
// command — un-starring is a full delete, per the review model.

import { SvelteMap } from 'svelte/reactivity';
import { createOptimisticQueue } from '$lib/optimistic-queue';

interface ServerRatings {
	locations: Record<string, number>;
	items: Record<string, number>;
}

export interface OptimisticRatings {
	/** The viewer's own rating for a location (0 = none). Reactive. */
	locationRating(id: string): number;
	/** The viewer's own rating for a menu item (0 = none). Reactive. */
	itemRating(id: string): number;
	/** Sets (1..5) or clears (0) the viewer's rating for a location, preserving text. */
	rateLocation(id: string, rating: number): void;
	/** Sets (1..5) or clears (0) the viewer's rating for a menu item, preserving text. */
	rateItem(id: string, rating: number): void;
}

export function createOptimisticRatings(options: {
	/** The server-loaded ratings, read as a getter so the values track it reactively. */
	serverRatings: () => ServerRatings;
	setLocationReview: (args: { locationId: string; rating: number }) => Promise<unknown>;
	clearLocationReview: (args: { locationId: string }) => Promise<unknown>;
	setItemReview: (args: { itemId: string; rating: number }) => Promise<unknown>;
	clearItemReview: (args: { itemId: string }) => Promise<unknown>;
}): OptimisticRatings {
	const { serverRatings, setLocationReview, clearLocationReview, setItemReview, clearItemReview } =
		options;

	// Pending overrides: a just-set id → its optimistic rating (0 = cleared), layered
	// over the server value until the write settles (or a server reload supersedes it).
	const pendingLocation = new SvelteMap<string, number>();
	const pendingItem = new SvelteMap<string, number>();
	const queue = createOptimisticQueue();

	function ratingOf(
		id: string,
		server: Record<string, number>,
		pending: SvelteMap<string, number>
	): number {
		return pending.has(id) ? (pending.get(id) ?? 0) : (server[id] ?? 0);
	}

	function rate(
		id: string,
		rating: number,
		pending: SvelteMap<string, number>,
		current: number,
		keyPrefix: string,
		set: (rating: number) => Promise<unknown>,
		clear: () => Promise<unknown>
	): void {
		if (rating === current) return;
		pending.set(id, rating);
		queue.enqueue(
			`${keyPrefix}:${id}`,
			() => (rating === 0 ? clear() : set(rating)),
			() => pending.set(id, current)
		);
	}

	return {
		locationRating(id) {
			return ratingOf(id, serverRatings().locations, pendingLocation);
		},
		itemRating(id) {
			return ratingOf(id, serverRatings().items, pendingItem);
		},
		rateLocation(id, rating) {
			const current = ratingOf(id, serverRatings().locations, pendingLocation);
			rate(
				id,
				rating,
				pendingLocation,
				current,
				'location',
				(r) => setLocationReview({ locationId: id, rating: r }),
				() => clearLocationReview({ locationId: id })
			);
		},
		rateItem(id, rating) {
			const current = ratingOf(id, serverRatings().items, pendingItem);
			rate(
				id,
				rating,
				pendingItem,
				current,
				'item',
				(r) => setItemReview({ itemId: id, rating: r }),
				() => clearItemReview({ itemId: id })
			);
		}
	};
}
