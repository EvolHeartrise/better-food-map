/// <reference types="bun-types" />
// Ordering guarantees of the optimistic like-write queue ($lib/like-queue),
// the client-side fix for the like-toggle write races on the map page
// (src/routes/+page.svelte): two rapid taps on one heart used to race their
// commands to D1 (the unlike DELETE could land before the like INSERT it was
// meant to undo), and a failed earlier toggle's revert could clobber a later
// toggle's optimistic state. The queue promises, per key:
//   • writes send strictly in enqueue order (SERIALIZED);
//   • a write superseded by a later enqueue on the same key never sends —
//     the latest write carries the final desired state (LATEST-WINS);
//   • a failed write reverts only while it is still the latest (GUARDED REVERT);
//   • keys are independent — one key's slow write never blocks another's.
import { test, expect, describe } from 'bun:test';
import { createLikeQueue } from '../src/lib/like-queue';

/** A send whose settlement the test controls, recording when it was called. */
function controlledSend(calls: string[], name: string) {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const gate = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const send = () => {
		calls.push(name);
		return gate;
	};
	return { send, resolve, reject };
}

/** A send that resolves immediately, recording that (and when) it was called. */
function instantSend(calls: string[], name: string) {
	return () => {
		calls.push(name);
		return Promise.resolve();
	};
}

/** Let queued microtasks drain (the queue chains plain promises). */
const settle = () => new Promise<void>((res) => setTimeout(res, 0));

describe('createLikeQueue', () => {
	test('a second write on the same key waits for the first to settle', async () => {
		const q = createLikeQueue();
		const calls: string[] = [];
		const a = controlledSend(calls, 'a');

		q.enqueue('k', a.send, () => {});
		await settle();
		expect(calls).toEqual(['a']); // a is on the wire, unresolved

		q.enqueue('k', instantSend(calls, 'b'), () => {});
		await settle();
		// b must not send while a is still in flight...
		expect(calls).toEqual(['a']);

		a.resolve();
		await settle();
		// ...and sends once a settles.
		expect(calls).toEqual(['a', 'b']);
	});

	test('a write superseded before sending is skipped (latest wins)', async () => {
		const q = createLikeQueue();
		const calls: string[] = [];
		// Both enqueued in the same tick: by the time the microtask chain runs the
		// first task, it is already superseded and must never send.
		q.enqueue('k', instantSend(calls, 'a'), () => {});
		q.enqueue('k', instantSend(calls, 'b'), () => {});
		await settle();
		expect(calls).toEqual(['b']);
	});

	test('a failed write reverts only while still the latest', async () => {
		const q = createLikeQueue();
		const calls: string[] = [];
		const reverts: string[] = [];
		const a = controlledSend(calls, 'a');

		q.enqueue('k', a.send, () => reverts.push('a'));
		await settle();
		// A newer tap arrives while a is in flight, then a fails: a's revert must
		// NOT clobber b's optimistic state.
		q.enqueue('k', instantSend(calls, 'b'), () => reverts.push('b'));
		a.reject(new Error('boom'));
		await settle();
		expect(reverts).toEqual([]);
		expect(calls).toEqual(['a', 'b']);
	});

	test('a failed write that is still the latest does revert', async () => {
		const q = createLikeQueue();
		const reverts: string[] = [];
		q.enqueue(
			'k',
			() => Promise.reject(new Error('boom')),
			() => reverts.push('a')
		);
		await settle();
		expect(reverts).toEqual(['a']);
	});

	test('keys are independent — a slow write on one key never blocks another', async () => {
		const q = createLikeQueue();
		const calls: string[] = [];
		const slow = controlledSend(calls, 'slow');
		q.enqueue('k1', slow.send, () => {});
		q.enqueue('k2', instantSend(calls, 'other'), () => {});
		await settle();
		expect(calls).toEqual(['slow', 'other']);
		slow.resolve();
	});

	test('a drained key starts fresh — later writes still send and serialize', async () => {
		const q = createLikeQueue();
		const calls: string[] = [];
		q.enqueue('k', instantSend(calls, 'a'), () => {});
		await settle();
		q.enqueue('k', instantSend(calls, 'b'), () => {});
		await settle();
		expect(calls).toEqual(['a', 'b']);
	});
});
