/// <reference types="bun-types" />
// Exercises deleteExpiredSessions against the real migration schema via the
// in-memory D1Like adapter: the opportunistic sweep the auth hook fires in the
// background, catching expired sessions whose cookie never returns (the lazy
// per-token cleanup in validateSessionToken misses those).

import { test, expect } from 'bun:test';
import { createSession, deleteExpiredSessions } from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('deleteExpiredSessions: drops expired rows, keeps live ones', async () => {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();

	const now = 10_000;
	await createSession(db, 's-expired', 'u1', now - 1, 0);
	// Boundary: matches validateSessionToken, which treats `now >= expires_at`
	// as expired — so a row expiring exactly at `now` is purged too.
	await createSession(db, 's-boundary', 'u1', now, 0);
	await createSession(db, 's-live', 'u1', now + 1, 0);

	await deleteExpiredSessions(db, now);

	const { results } = await db.prepare(`SELECT id FROM sessions ORDER BY id`).all<{ id: string }>();
	expect(results.map((r) => r.id)).toEqual(['s-live']);
});

test('deleteExpiredSessions: no-op on a table with nothing expired', async () => {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();
	await createSession(db, 's-live', 'u1', 5_000, 0);

	await deleteExpiredSessions(db, 4_000);

	const row = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(row?.n).toBe(1);
});
