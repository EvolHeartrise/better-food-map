// Optimistic bookmark state for the map page (companion to $lib/optimistic-queue).
//
// A tap on a bookmark reflects instantly, layered as a pending override over the
// server's saved set, and reverts if its write fails. Location and item bookmarks
// are mirror images — same pending overlay over the server set, same optimistic
// set-then-revert, same per-key serialized write queue — so both live here behind
// one factory the page instantiates with its reactive `serverBookmarks` and the two
// remote setters. (Replaces the old like state; migration 0029 split the heart into
// a private bookmark + a rating — see $lib/ratings.svelte for the latter.)

import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { createOptimisticQueue } from '$lib/optimistic-queue';

interface ServerBookmarks {
	locationIds: string[];
	itemIds: string[];
}

export interface OptimisticBookmarks {
	readonly bookmarkedLocationIds: SvelteSet<string>;
	readonly bookmarkedItemIds: SvelteSet<string>;
	toggleLocationBookmark(id: string): void;
	toggleItemBookmark(id: string): void;
}

// Overlay the pending map of just-toggled ids onto the server set. The pending
// map is reactive, so the id set recomputes as toggles land; a later server
// reload supersedes the pending entry.
function overlay(serverIds: string[], pending: SvelteMap<string, boolean>): SvelteSet<string> {
	const ids = new SvelteSet(serverIds);
	for (const [id, on] of pending) {
		if (on) ids.add(id);
		else ids.delete(id);
	}
	return ids;
}

export function createOptimisticBookmarks(options: {
	/** The server-loaded bookmark ids, read as a getter so the sets track it reactively. */
	serverBookmarks: () => ServerBookmarks;
	setLocationBookmarked: (args: { locationId: string; on: boolean }) => Promise<unknown>;
	setItemBookmarked: (args: { itemId: string; on: boolean }) => Promise<unknown>;
}): OptimisticBookmarks {
	const { serverBookmarks, setLocationBookmarked, setItemBookmarked } = options;

	// The pending overrides: a just-toggled id → its optimistic saved state, layered
	// over the server set until the write settles (or a server reload supersedes it).
	const pendingLocation = new SvelteMap<string, boolean>();
	const pendingItem = new SvelteMap<string, boolean>();

	// Serializes the bookmark commands per saved thing ($lib/optimistic-queue): two
	// rapid taps on one control would otherwise race their writes, and an old
	// failure's revert could clobber a newer tap's optimistic state.
	const queue = createOptimisticQueue();

	const bookmarkedLocationIds = $derived(overlay(serverBookmarks().locationIds, pendingLocation));
	const bookmarkedItemIds = $derived(overlay(serverBookmarks().itemIds, pendingItem));

	function toggleLocationBookmark(id: string): void {
		const on = bookmarkedLocationIds.has(id);
		pendingLocation.set(id, !on);
		queue.enqueue(
			`location:${id}`,
			() => setLocationBookmarked({ locationId: id, on: !on }),
			() => pendingLocation.set(id, on)
		);
	}

	function toggleItemBookmark(id: string): void {
		const on = bookmarkedItemIds.has(id);
		pendingItem.set(id, !on);
		queue.enqueue(
			`item:${id}`,
			() => setItemBookmarked({ itemId: id, on: !on }),
			() => pendingItem.set(id, on)
		);
	}

	return {
		get bookmarkedLocationIds() {
			return bookmarkedLocationIds;
		},
		get bookmarkedItemIds() {
			return bookmarkedItemIds;
		},
		toggleLocationBookmark,
		toggleItemBookmark
	};
}
