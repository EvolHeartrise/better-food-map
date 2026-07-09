/// <reference types="bun-types" />
// Exercises the SERVER side of the saved UI locale (migration 0024) against the
// real migration schema via the in-memory D1Like adapter: getUserLocale /
// setUserLocale — the per-user single-locale upsert round-trip — plus the fold
// into getSessionWithUser that the request-path resolution reads from. Mirrors
// diet-profile-store.test.ts.

import { test, expect } from 'bun:test';
import { getSessionWithUser, getUserLocale, setUserLocale } from '../src/lib/server/db';
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

test('getUserLocale / setUserLocale: round-trips and upserts per user', async () => {
	const db = await dbWithUser();

	// No row yet → no saved locale.
	expect(await getUserLocale(db, 'u1')).toBeNull();

	await setUserLocale(db, 'u1', 'fr', 1000);
	expect(await getUserLocale(db, 'u1')).toBe('fr');

	// A second save for the same user overwrites (upsert), not duplicates.
	await setUserLocale(db, 'u1', 'en', 2000);
	expect(await getUserLocale(db, 'u1')).toBe('en');

	const { results } = await db
		.prepare(`SELECT COUNT(*) AS n FROM user_locale WHERE user_id = 'u1'`)
		.all<{ n: number }>();
	expect(results[0].n).toBe(1);
});

test('getUserLocale: an unsupported stored value reads as no saved locale', async () => {
	const db = await dbWithUser();
	// Bypass setUserLocale (which only accepts a validated Locale) to simulate a value
	// left over from a dropped locale — it must read back as null, not leak through.
	// 'tlh' (Klingon) is safely outside any plausible supported-locale set.
	await db
		.prepare(`INSERT INTO user_locale (user_id, locale, updated_at) VALUES (?, ?, ?)`)
		.bind('u1', 'tlh', 1000)
		.run();
	expect(await getUserLocale(db, 'u1')).toBeNull();
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
