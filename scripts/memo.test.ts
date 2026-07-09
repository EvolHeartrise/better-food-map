/// <reference types="bun-types" />
// Exercises ttlMemo — the TTL memoiser behind the cached getStats remote query.
// The invariants that matter: a hit inside the window never re-invokes fn; the
// window is [t, t+ttl) measured from invocation; concurrent misses share ONE
// in-flight promise (no stampede); and a rejection is never cached — including
// the late-rejection case where an expired in-flight entry must not evict the
// fresher one that replaced it. All driven by an injected fake clock.

import { test, expect } from 'bun:test';
import { ttlMemo } from '../src/lib/server/memo';

// A manually-advanced clock, so expiry is tested without real timers.
function clock(start = 0) {
	let t = start;
	return { now: () => t, tick: (ms: number) => (t += ms) };
}

test('a hit within the TTL returns the cached promise without re-calling fn', async () => {
	const c = clock();
	let calls = 0;
	const memo = ttlMemo(1000, async () => ++calls, c.now);

	expect(await memo()).toBe(1);
	c.tick(999); // last instant inside the window — expiry is exclusive
	expect(await memo()).toBe(1);
	expect(calls).toBe(1);
});

test('the entry expires after the TTL and the next call refetches', async () => {
	const c = clock();
	let calls = 0;
	const memo = ttlMemo(1000, async () => ++calls, c.now);

	expect(await memo()).toBe(1);
	c.tick(1000); // now === expires is already a miss: the window is [t, t+ttl)
	expect(await memo()).toBe(2);
	expect(calls).toBe(2);
});

test('concurrent misses collapse into one underlying call', async () => {
	const c = clock();
	let calls = 0;
	let release!: (v: string) => void;
	const memo = ttlMemo(
		1000,
		() => {
			calls++;
			return new Promise<string>((resolve) => (release = resolve));
		},
		c.now
	);

	// Both calls arrive while the first fn() is still in flight.
	const a = memo();
	const b = memo();
	release('shared');
	expect(await a).toBe('shared');
	expect(await b).toBe('shared');
	expect(calls).toBe(1);
});

test('a rejection is never cached — the next call retries immediately', async () => {
	const c = clock();
	let calls = 0;
	let fail = true;
	const memo = ttlMemo(
		1000,
		async () => {
			calls++;
			if (fail) throw new Error('db down');
			return 'ok';
		},
		c.now
	);

	// Awaiting the caught rejection also guarantees the memo's eviction handler
	// (attached first, at creation) has already run before the retry below.
	expect(await memo().catch((e: Error) => e.message)).toBe('db down');
	// Clock untouched — still inside the would-be TTL window, yet the failed
	// entry was evicted on rejection, so this call re-invokes fn.
	fail = false;
	expect(await memo()).toBe('ok');
	expect(calls).toBe(2);
});

test('a late rejection from an expired in-flight entry does not evict its replacement', async () => {
	const c = clock();
	const pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
	const memo = ttlMemo(
		1000,
		() => new Promise<string>((resolve, reject) => pending.push({ resolve, reject })),
		c.now
	);

	// First entry outlives its own TTL while still in flight...
	const first = memo();
	c.tick(1000);
	// ...so this miss replaces it, and only then does the old promise reject.
	const second = memo();
	pending[0].reject(new Error('late failure'));
	expect(await first.catch((e: Error) => e.message)).toBe('late failure');
	// The replacement is untouched: it resolves, and a further call hits its cache.
	pending[1].resolve('fresh');
	expect(await second).toBe('fresh');
	expect(await memo()).toBe('fresh');
	expect(pending.length).toBe(2);
});
