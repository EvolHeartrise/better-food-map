// Optimistic like state for the map page (companion to $lib/like-queue).
//
// A tap on a heart reflects instantly, layered as a pending override over the
// server's like set, and reverts if its write fails. Location likes and item
// likes are mirror images — same pending overlay over the server set, same
// optimistic set-then-revert, same per-key serialized write queue — so both
// live here behind one factory the page instantiates with its reactive
// `serverLikes` and the two remote setters.

import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { createLikeQueue } from '$lib/like-queue';

interface ServerLikes {
	locationIds: string[];
	itemIds: string[];
}

export interface OptimisticLikes {
	readonly likedLocationIds: SvelteSet<string>;
	readonly likedItemIds: SvelteSet<string>;
	toggleLocationLike(id: string): void;
	toggleItemLike(id: string): void;
}

// Overlay the pending map of just-toggled ids onto the server set. The pending
// map is reactive, so the id set recomputes as toggles land; a later server
// reload supersedes the pending entry.
function overlayLikes(serverIds: string[], pending: SvelteMap<string, boolean>): SvelteSet<string> {
	const ids = new SvelteSet(serverIds);
	for (const [id, liked] of pending) {
		if (liked) ids.add(id);
		else ids.delete(id);
	}
	return ids;
}

export function createOptimisticLikes(options: {
	/** The server-loaded like ids, read as a getter so the sets track it reactively. */
	serverLikes: () => ServerLikes;
	setLocationLiked: (args: { locationId: string; liked: boolean }) => Promise<unknown>;
	setItemLiked: (args: { itemId: string; liked: boolean }) => Promise<unknown>;
}): OptimisticLikes {
	const { serverLikes, setLocationLiked, setItemLiked } = options;

	// The pending overrides: a just-toggled id → its optimistic liked state, layered
	// over the server set until the write settles (or a server reload supersedes it).
	const pendingLocationLikes = new SvelteMap<string, boolean>();
	const pendingItemLikes = new SvelteMap<string, boolean>();

	// Serializes the like commands per liked thing ($lib/like-queue): without it,
	// two rapid taps on one heart race their writes — the unlike can land on D1
	// before the like it undoes, persisting the opposite of the UI — and an old
	// failure's revert can clobber a newer tap's optimistic state. The queue sends
	// writes for a key strictly in tap order, skips superseded ones (the latest
	// tap carries the final desired state) and gates each revert on still being
	// the latest.
	const likeQueue = createLikeQueue();

	const likedLocationIds = $derived(overlayLikes(serverLikes().locationIds, pendingLocationLikes));
	const likedItemIds = $derived(overlayLikes(serverLikes().itemIds, pendingItemLikes));

	function toggleLocationLike(id: string): void {
		const liked = likedLocationIds.has(id);
		pendingLocationLikes.set(id, !liked);
		likeQueue.enqueue(
			`location:${id}`,
			() => setLocationLiked({ locationId: id, liked: !liked }),
			() => pendingLocationLikes.set(id, liked)
		);
	}

	function toggleItemLike(id: string): void {
		const liked = likedItemIds.has(id);
		pendingItemLikes.set(id, !liked);
		likeQueue.enqueue(
			`item:${id}`,
			() => setItemLiked({ itemId: id, liked: !liked }),
			() => pendingItemLikes.set(id, liked)
		);
	}

	return {
		get likedLocationIds() {
			return likedLocationIds;
		},
		get likedItemIds() {
			return likedItemIds;
		},
		toggleLocationLike,
		toggleItemLike
	};
}
