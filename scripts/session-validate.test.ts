/// <reference types="bun-types" />
// Exercises the session-token boundary rules in src/lib/server/session.ts
// (`$app`-free precisely so this file can import it) against the real migration
// schema: an expired token drops its row, a token past the half-life refresh
// threshold slides its expiry (signalling a cookie re-set), and a young token
// is left alone. Sessions are created through createUserSession so the real
// token→SHA-256→row-id path is what's under test; expiry is then rewound with
// direct SQL to place each session at the boundary being probed.

import { test, expect } from 'bun:test';
import {
	SESSION_TTL_MS,
	createUserSession,
	invalidateSessionToken,
	validateSessionToken
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

async function setExpiry(db: D1Like, sessionId: string, expiresAt: number): Promise<void> {
	await db
		.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
		.bind(expiresAt, sessionId)
		.run();
}

test('createUserSession stores the token hash, not the token', async () => {
	const db = await dbWithUser();
	const { token, session } = await createUserSession(db, 'u1');

	expect(session.id).not.toBe(token);
	const row = await db
		.prepare(`SELECT id FROM sessions WHERE id = ?`)
		.bind(session.id)
		.first<{ id: string }>();
	expect(row?.id).toBe(session.id);
});

test('validateSessionToken: unknown token returns null', async () => {
	const db = await dbWithUser();
	expect(await validateSessionToken(db, 'not-a-real-token')).toBeNull();
});

test('validateSessionToken: expired token returns null and deletes the row', async () => {
	const db = await dbWithUser();
	const { token, session } = await createUserSession(db, 'u1');
	await setExpiry(db, session.id, Date.now() - 1);

	expect(await validateSessionToken(db, token)).toBeNull();

	const row = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(row?.n).toBe(0);
});

test('validateSessionToken: token in second half of life refreshes and slides expiry', async () => {
	const db = await dbWithUser();
	const { token, session } = await createUserSession(db, 'u1');
	// Deep in the refresh window: only 1h of life left, well past the half-life.
	const before = Date.now();
	const staleExpiry = before + 60 * 60 * 1000;
	await setExpiry(db, session.id, staleExpiry);

	const result = await validateSessionToken(db, token);
	expect(result).not.toBeNull();
	expect(result?.refreshed).toBe(true);
	expect(result?.user.id).toBe('u1');
	// Expiry slid a full TTL forward from "now", both in the return and the row.
	expect(result?.session.expires_at).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
	const row = await db
		.prepare(`SELECT expires_at FROM sessions WHERE id = ?`)
		.bind(session.id)
		.first<{ expires_at: number }>();
	expect(row?.expires_at).toBe(result?.session.expires_at);
});

test('validateSessionToken: token in first half of life is returned untouched', async () => {
	const db = await dbWithUser();
	const { token, session } = await createUserSession(db, 'u1');
	// A freshly-created session has its whole TTL left — before the half-life
	// threshold, so no refresh and no cookie re-set.
	const result = await validateSessionToken(db, token);
	expect(result).not.toBeNull();
	expect(result?.refreshed).toBe(false);
	expect(result?.session.expires_at).toBe(session.expires_at);
	const row = await db
		.prepare(`SELECT expires_at FROM sessions WHERE id = ?`)
		.bind(session.id)
		.first<{ expires_at: number }>();
	expect(row?.expires_at).toBe(session.expires_at);
});

test('invalidateSessionToken deletes the session row', async () => {
	const db = await dbWithUser();
	const { token } = await createUserSession(db, 'u1');

	await invalidateSessionToken(db, token);

	expect(await validateSessionToken(db, token)).toBeNull();
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(row?.n).toBe(0);
});
