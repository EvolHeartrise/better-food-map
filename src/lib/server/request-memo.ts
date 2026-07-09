// Request-safe wrapper around `ttlMemo` for memoising REQUEST-SCOPED server
// reads (anything ultimately backed by a per-request binding like D1). Lives
// apart from memo.ts on purpose: memo.ts is runtime-agnostic and exercised by
// plain `bun test` (scripts/memo.test.ts), where `$app/server` — imported
// here for `getRequestEvent` — does not resolve.
import { getRequestEvent } from '$app/server';
import { ttlMemo } from './memo';

/**
 * Memoises `fn` for `ttlMs` milliseconds exactly like {@link ttlMemo}, and on
 * every call keeps the populating request alive until the cached promise
 * settles.
 *
 * Why that matters: the memo caches the PROMISE, and on Workers a cache-miss
 * read is tied to the request that started it. If that request ends before the
 * read settles — an SSR render returning early, a crawler disconnect, an edge
 * timeout — the runtime tears down its I/O and the memo is left holding a
 * promise that NEVER settles, silently poisoning every consumer on the isolate
 * for the rest of the TTL window. `waitUntil` keeps the request context alive
 * until the read completes, so the cached promise always settles. (cell-cache.ts
 * documents the production incident this pattern guards against.)
 *
 * Rejections are swallowed only for `waitUntil`'s sake — the memo already
 * evicts a rejected entry, and awaiting callers still see the error.
 *
 * `platform`/`ctx` are optional-chained: under `vite dev` there is no Workers
 * execution context, and dev never cancels a request's I/O mid-read anyway.
 *
 * Because `fn` runs inside a request (a cache miss only ever happens while one
 * is being served), it may safely resolve request-scoped state — e.g. call
 * `requireDb()` — as long as it does so INSIDE the function body, per call.
 */
export function requestSafeTtlMemo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
	const memoised = ttlMemo(ttlMs, fn);
	return () => {
		const promise = memoised();
		getRequestEvent().platform?.ctx?.waitUntil(
			promise.then(
				() => undefined,
				() => undefined
			)
		);
		return promise;
	};
}
