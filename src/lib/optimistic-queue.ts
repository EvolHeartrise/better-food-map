// Per-key serialization for optimistic user writes — bookmarks AND ratings
// (src/lib/bookmarks.svelte, src/lib/ratings.svelte). Value-agnostic: it only
// orders `send`/`revert` thunks, so the same queue serves a boolean bookmark
// toggle and a 1..5 rating set alike.
//
// An optimistic write is fire-and-forget UI over a server command, and two rapid
// taps on the same control used to race: nothing ordered the two commands, so a
// later write could land on the server before an earlier one it was meant to
// supersede, persisting the opposite of what the UI shows — and a failed earlier
// write's revert could clobber a LATER write's optimistic state.
//
// This queue fixes both, client-side and per key (one key per liked thing):
//   • SERIALIZED — each enqueued write waits for the previous write on the same
//     key to settle before it sends, so commands reach the server in tap order;
//   • LATEST-WINS — a write that has been superseded by a later toggle on the
//     same key never sends at all (the later write carries the final desired
//     state, so sending both would be redundant at best and reordered at worst);
//   • GUARDED REVERT — a failed write calls its `revert` only while it is still
//     the LATEST toggle for its key, so an old failure can't stomp the
//     optimistic state a newer tap just set.
//
// Plain non-reactive plumbing, a pure module so scripts/optimistic-queue.test.ts
// can exercise the ordering guarantees directly.

interface QueueEntry {
	/** The settled-or-pending tail of the write chain for this key. */
	tail: Promise<void>;
	/** Bumped per enqueue; a task whose generation is stale is superseded. */
	gen: number;
}

export interface OptimisticQueue {
	/**
	 * Queue one optimistic write for `key`. `send` performs the server command
	 * (capturing the desired state at tap time); `revert` undoes the tap's
	 * optimistic UI state and runs only if `send` fails while this is still the
	 * latest write for the key.
	 */
	enqueue(key: string, send: () => Promise<unknown>, revert: () => void): void;
}

export function createOptimisticQueue(): OptimisticQueue {
	const queues = new Map<string, QueueEntry>();

	function enqueue(key: string, send: () => Promise<unknown>, revert: () => void): void {
		let entry = queues.get(key);
		if (!entry) {
			entry = { tail: Promise.resolve(), gen: 0 };
			queues.set(key, entry);
		}
		entry.gen += 1;
		const gen = entry.gen;
		const current = entry;
		current.tail = current.tail.then(async () => {
			// Superseded before it got to send: skip — the latest enqueued write
			// (already chained behind this one) sends the final desired state.
			if (current.gen !== gen) return;
			try {
				await send();
			} catch {
				// Revert only while still the latest: a newer tap owns the
				// optimistic state now, and its own send/revert will settle it.
				if (current.gen === gen) revert();
			}
			// Chain drained (no later write queued): drop the entry so the map
			// doesn't grow with every heart ever tapped.
			if (current.gen === gen) queues.delete(key);
		});
	}

	return { enqueue };
}
