/// <reference types="bun-types" />
// Exercises the mobile-app one-time auth code (src/lib/server/app-auth.ts,
// `$app`-free precisely so this file can import it) against the real migration
// schema (migration 0025's app_auth_codes). Covers the security-critical
// boundaries: a code redeems exactly once (happy path), an expired code is
// rejected, an unknown code is rejected, a REPLAY of a redeemed code loses the
// race, and the raw code is NEVER stored — only its SHA-256.

import { test, expect } from 'bun:test';
import {
	createAppAuthCode,
	exchangeAppAuthCode,
	APP_CODE_TTL_MS
} from '../src/lib/server/app-auth';
import { sha256Hex } from '../src/lib/server/token';
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

function codeCount(db: D1Like): Promise<number> {
	return db
		.prepare(`SELECT COUNT(*) AS n FROM app_auth_codes`)
		.first<{ n: number }>()
		.then((r) => r?.n ?? -1);
}

test('createAppAuthCode stores the SHA-256 hash, never the raw code', async () => {
	const db = await dbWithUser();
	const now = Date.now();
	const code = await createAppAuthCode(db, 'u1', now);

	const row = await db
		.prepare(`SELECT code_hash, user_id, expires_at FROM app_auth_codes`)
		.first<{ code_hash: string; user_id: string; expires_at: number }>();
	expect(row?.code_hash).not.toBe(code);
	expect(row?.code_hash).toBe(await sha256Hex(code));
	expect(row?.user_id).toBe('u1');
	expect(row?.expires_at).toBe(now + APP_CODE_TTL_MS);
});

test('exchangeAppAuthCode: happy path mints a session and consumes the code', async () => {
	const db = await dbWithUser();
	const now = Date.now();
	const code = await createAppAuthCode(db, 'u1', now);

	const session = await exchangeAppAuthCode(db, code, now);
	expect(session).not.toBeNull();
	expect(session?.user.id).toBe('u1');
	expect(typeof session?.token).toBe('string');
	expect(session?.expiresAt).toBeGreaterThan(now);

	// The code row is gone (single-use)…
	expect(await codeCount(db)).toBe(0);
	// …and a real session row now exists for the minted token.
	const sess = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(sess?.n).toBe(1);
});

test('exchangeAppAuthCode: a replay of a redeemed code fails', async () => {
	const db = await dbWithUser();
	const now = Date.now();
	const code = await createAppAuthCode(db, 'u1', now);

	expect(await exchangeAppAuthCode(db, code, now)).not.toBeNull();
	// Second redemption of the SAME code finds the row already consumed.
	expect(await exchangeAppAuthCode(db, code, now)).toBeNull();
});

test('exchangeAppAuthCode: an unknown code is rejected', async () => {
	const db = await dbWithUser();
	expect(await exchangeAppAuthCode(db, 'never-issued-code', Date.now())).toBeNull();
});

test('exchangeAppAuthCode: an expired code is rejected and consumed', async () => {
	const db = await dbWithUser();
	const now = Date.now();
	const code = await createAppAuthCode(db, 'u1', now);
	// Push its expiry into the past.
	await db
		.prepare(`UPDATE app_auth_codes SET expires_at = ? WHERE code_hash = ?`)
		.bind(now - 1, await sha256Hex(code))
		.run();

	expect(await exchangeAppAuthCode(db, code, now)).toBeNull();
	// The row is consumed even though it was expired (an expired code is spent).
	expect(await codeCount(db)).toBe(0);
});

test('exchangeAppAuthCode: opportunistically sweeps OTHER expired codes', async () => {
	const db = await dbWithUser();
	const now = Date.now();
	const stale = await createAppAuthCode(db, 'u1', now);
	await db
		.prepare(`UPDATE app_auth_codes SET expires_at = ? WHERE code_hash = ?`)
		.bind(now - 1, await sha256Hex(stale))
		.run();
	const fresh = await createAppAuthCode(db, 'u1', now);

	// Redeeming the fresh code also sweeps the abandoned stale one.
	expect(await exchangeAppAuthCode(db, fresh, now)).not.toBeNull();
	expect(await codeCount(db)).toBe(0);
});
