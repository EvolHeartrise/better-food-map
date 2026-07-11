/// <reference types="bun-types" />
// Exercises the SERVER side of the saved UI locale (migration 0024) against the
// real migration schema via the in-memory D1Like adapter: setUserLocale — the
// per-user single-locale upsert write path — read back through the fold into
// getSessionWithUser that the request-path resolution reads from. Mirrors
// diet-profile-store.test.ts.

import { test, expect } from 'bun:test';
import { getSessionWithUser, setUserLocale } from '../src/lib/server/db';
import { createUserSession } from '../src/lib/server/session';
import { freshDb } from './test-d1';
import type { D1Like } from '../src/lib/server/db';

async function dbWithUser(): Promise<D1Like> {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();
	return db;
}

test('setUserLocale: round-trips and upserts per user', async () => {
	const db = await dbWithUser();
	const { session } = await createUserSession(db, 'u1');

	await setUserLocale(db, 'u1', 'fr', 1000);
	expect((await getSessionWithUser(db, session.id))?.locale).toBe('fr');

	// A second save for the same user overwrites (upsert), not duplicates.
	await setUserLocale(db, 'u1', 'en-US', 2000);
	expect((await getSessionWithUser(db, session.id))?.locale).toBe('en-US');

	const { results } = await db
		.prepare(`SELECT COUNT(*) AS n FROM user_locale WHERE user_id = 'u1'`)
		.all<{ n: number }>();
	expect(results[0].n).toBe(1);
});

test('getSessionWithUser folds in the saved locale (null until set)', async () => {
	const db = await dbWithUser();
	const { session } = await createUserSession(db, 'u1');

	// Before any save the folded locale is null.
	const before = await getSessionWithUser(db, session.id);
	expect(before?.user.id).toBe('u1');
	expect(before?.locale).toBeNull();

	// After a save the same one lookup carries it — no separate read needed.
	await setUserLocale(db, 'u1', 'fr', 3000);
	const after = await getSessionWithUser(db, session.id);
	expect(after?.locale).toBe('fr');
});
