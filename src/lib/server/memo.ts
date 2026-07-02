// Tiny TTL memoiser for server-side reads whose staleness is invisible to users
// (e.g. the landing overlay's coverage totals). Like db.ts, this module is
// RUNTIME-AGNOSTIC — no `bun:`/`node:` imports — so the same code runs in the
// deployed Worker isolate, under `vite dev`, and in `bun test`.

/**
 * Memoises `fn` for `ttlMs` milliseconds. The PROMISE is cached, not the settled
 * value, so concurrent cache misses collapse into a single underlying call
 * instead of stampeding whatever `fn` fronts. A rejection is never cached: the
 * entry is evicted the moment its promise rejects, so the next call retries.
 * The TTL window opens when `fn` is invoked (not when it settles), read from the
 * injectable `now` clock so tests can drive expiry without real timers.
 */
export function ttlMemo<T>(
	ttlMs: number,
	fn: () => Promise<T>,
	now: () => number = Date.now
): () => Promise<T> {
	let cached: { promise: Promise<T>; expires: number } | null = null;
	return () => {
		if (cached && now() < cached.expires) return cached.promise;
		const entry = {
			promise: fn().catch((err: unknown) => {
				// Evict only our own entry: an entry can expire while still in flight,
				// and its late rejection must not blow away the fresher one that
				// replaced it.
				if (cached === entry) cached = null;
				throw err;
			}),
			expires: now() + ttlMs
		};
		cached = entry;
		return entry.promise;
	};
}
