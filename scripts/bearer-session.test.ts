/// <reference types="bun-types" />
// Exercises the mobile-app BEARER session path: the pure `parseBearerToken`
// header parser, plus resolving a bearer token through the same
// createLazySessionResolver the auth hook installs — but with a no-op cookie sink
// (a bearer request never touches cookies). Mirrors the session boundaries of
// session-validate.test.ts (valid / garbage / expired) for the bearer entry point.

import { test, expect } from 'bun:test';
import {
	createLazySessionResolver,
	createUserSession,
	parseBearerToken,
	sessionSourceFor,
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

/** The no-op sink the auth hook uses on the bearer path — records any (illegal)
 *  cookie writes so the tests can assert none happen. */
function noopSink(): SessionCookieSink & { sets: number; clears: number } {
	const sink = {
		sets: 0,
		clears: 0,
		setCookie() {
			sink.sets++;
		},
		clearCookie() {
			sink.clears++;
		}
	};
	return sink;
}

test('parseBearerToken: extracts the token from a Bearer header', () => {
	expect(parseBearerToken('Bearer abc123')).toBe('abc123');
	// Scheme is case-insensitive; extra whitespace tolerated.
	expect(parseBearerToken('bearer   deadBEEF')).toBe('deadBEEF');
	expect(parseBearerToken('BEARER\ttok')).toBe('tok');
});

test('parseBearerToken: returns undefined for non-Bearer / absent headers', () => {
	expect(parseBearerToken(null)).toBeUndefined();
	expect(parseBearerToken(undefined)).toBeUndefined();
	expect(parseBearerToken('')).toBeUndefined();
	expect(parseBearerToken('Basic abc123')).toBeUndefined();
	expect(parseBearerToken('Bearer')).toBeUndefined(); // no credential
	expect(parseBearerToken('Bearer ')).toBeUndefined();
});

test('sessionSourceFor: a Bearer header classifies as bearer, everything else as cookie', () => {
	// This is the classification the auth hook records on event.locals.sessionSource,
	// which requireBearerUser ($lib/server/api) uses to reject cookie-driven mutations.
	expect(sessionSourceFor('Bearer abc123')).toBe('bearer');
	expect(sessionSourceFor('bearer\tdeadBEEF')).toBe('bearer');
	// No credential / not a bearer scheme / absent → the cookie path (whether or not
	// a cookie is actually present), so a mutation with only a session cookie is
	// classified 'cookie' and rejected by requireBearerUser.
	expect(sessionSourceFor(null)).toBe('cookie');
	expect(sessionSourceFor(undefined)).toBe('cookie');
	expect(sessionSourceFor('')).toBe('cookie');
	expect(sessionSourceFor('Basic abc123')).toBe('cookie');
	expect(sessionSourceFor('Bearer')).toBe('cookie');
});

test('bearer resolution: a valid token resolves the user with no cookie writes', async () => {
	const db = await dbWithUser();
	const { token } = await createUserSession(db, 'u1');
	const sink = noopSink();

	const resolved = await createLazySessionResolver(db, token, sink)();
	expect(resolved?.user.id).toBe('u1');
	// The bearer path must never set or clear a cookie.
	expect(sink.sets).toBe(0);
	expect(sink.clears).toBe(0);
});

test('bearer resolution: a garbage token resolves null (and writes no cookie)', async () => {
	const db = await dbWithUser();
	const sink = noopSink();
	// clearCookie is a no-op on the bearer path, so an invalid token simply yields
	// null with no observable cookie effect.
	expect(await createLazySessionResolver(db, 'not-a-real-token', sink)()).toBeNull();
	expect(sink.sets).toBe(0);
	expect(sink.clears).toBe(1);
});

test('bearer resolution: an expired session resolves null and deletes the row', async () => {
	const db = await dbWithUser();
	const { token, session } = await createUserSession(db, 'u1');
	await db
		.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
		.bind(Date.now() - 1, session.id)
		.run();
	const sink = noopSink();

	expect(await createLazySessionResolver(db, token, sink)()).toBeNull();
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
	expect(row?.n).toBe(0);
});
