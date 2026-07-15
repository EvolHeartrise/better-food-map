/// <reference types="bun-types" />
// Exercises createLazySessionResolver (src/lib/server/session.ts) — the lazy,
// per-request-memoized session resolver the auth hook installs as
// `locals.getSession`. What matters here, beyond the token rules already
// covered by session-validate.test.ts:
//   • laziness: building the resolver touches neither D1 nor the cookies —
//     requests that never ask who is signed in pay nothing;
//   • memoization: any number of calls (including concurrent ones) share ONE
//     validateSessionToken read;
//   • the deferred cookie side effects match the old eager hook exactly —
//     clear on an invalid/expired token, re-set on a sliding refresh, no
//     touch on a young valid token.

import { test, expect } from 'bun:test';
import {
	SESSION_TTL_MS,
	createLazySessionResolver,
	createUserSession,
	type SessionCookieSink
} from '../src/lib/server/session';
import type { D1Like } from '../src/lib/server/db';
import { freshDb } from './test-d1';

async function dbWithUser(): Promise<D1Like> {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();
	return db;
}

/** Wraps a D1Like so the test can count how many statements were prepared. */
function countingDb(db: D1Like): { db: D1Like; count: () => number } {
	let prepares = 0;
	const wrapped: D1Like = {
		prepare(sql: string) {
			prepares++;
			return db.prepare(sql);
		},
		batch: db.batch.bind(db)
	};
	return { db: wrapped, count: () => prepares };
}

/** A cookie sink that records every set/clear. */
function recordingSink(): SessionCookieSink & { sets: number[]; clears: number } {
	const sink = {
		sets: [] as number[],
		clears: 0,
		setCookie(_token: string, expiresAt: number) {
			sink.sets.push(expiresAt);
		},
		clearCookie() {
			sink.clears++;
		}
	};
	return sink;
}

test('building the resolver performs no D1 work and no cookie writes', async () => {
	const base = await dbWithUser();
	const { token } = await createUserSession(base, 'u1');
	const { db, count } = countingDb(base);
	const sink = recordingSink();

	createLazySessionResolver(db, token, sink);

	expect(count()).toBe(0);
	expect(sink.sets).toEqual([]);
	expect(sink.clears).toBe(0);
});

test('repeated and concurrent calls share a single session read', async () => {
	const base = await dbWithUser();
	const { token } = await createUserSession(base, 'u1');
	const { db, count } = countingDb(base);
	const sink = recordingSink();
	const getSession = createLazySessionResolver(db, token, sink);

	// Two concurrent callers (e.g. getCurrentUser and getBookmarks in one batched
	// request) plus a later sequential one.
	const [a, b] = await Promise.all([getSession(), getSession()]);
	const c = await getSession();

	expect(a?.user.id).toBe('u1');
	expect(b).toBe(a);
	expect(c).toBe(a);
	// One validateSessionToken == one prepared SELECT; a young session neither
	// refreshes nor deletes, so no further statements and no cookie writes.
	expect(count()).toBe(1);
	expect(sink.sets).toEqual([]);
	expect(sink.clears).toBe(0);
});

test('no token or no db resolves null without touching anything', async () => {
	const base = await dbWithUser();
	const { db, count } = countingDb(base);
	const sink = recordingSink();

	expect(await createLazySessionResolver(db, undefined, sink)()).toBeNull();
	expect(await createLazySessionResolver(undefined, 'some-token', sink)()).toBeNull();
	expect(count()).toBe(0);
	expect(sink.sets).toEqual([]);
	expect(sink.clears).toBe(0);
});

test('invalid token resolves null and clears the cookie exactly once', async () => {
	const base = await dbWithUser();
	const sink = recordingSink();
	const getSession = createLazySessionResolver(base, 'not-a-real-token', sink);

	expect(await getSession()).toBeNull();
	expect(await getSession()).toBeNull(); // memoized: no second clear
	expect(sink.clears).toBe(1);
	expect(sink.sets).toEqual([]);
});

test('expired token resolves null, deletes the row and clears the cookie', async () => {
	const base = await dbWithUser();
	const { token, session } = await createUserSession(base, 'u1');
	await base
		.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
		.bind(Date.now() - 1, session.id)
		.run();
	const sink = recordingSink();

	expect(await createLazySessionResolver(base, token, sink)()).toBeNull();
	expect(sink.clears).toBe(1);
	const row = await base.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(row?.n).toBe(0);
});

test('token past the refresh threshold slides expiry and re-sets the cookie', async () => {
	const base = await dbWithUser();
	const { token, session } = await createUserSession(base, 'u1');
	const before = Date.now();
	// Deep in the refresh window: only 1h of life left, well past the half-life.
	await base
		.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
		.bind(before + 60 * 60 * 1000, session.id)
		.run();
	const sink = recordingSink();
	const getSession = createLazySessionResolver(base, token, sink);

	const resolved = await getSession();
	if (!resolved) throw new Error('expected a resolved session');
	expect(resolved.user.id).toBe('u1');
	expect(resolved.session.expires_at).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
	expect(sink.sets).toEqual([resolved.session.expires_at]);
	expect(sink.clears).toBe(0);

	// Memoized: a second call re-sets nothing.
	await getSession();
	expect(sink.sets.length).toBe(1);
});
