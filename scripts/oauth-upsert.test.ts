/// <reference types="bun-types" />
// Exercises upsertOAuthUser's verified-email policy against the real migration
// schema: an unverified `email` claim is never persisted (Google issues id
// tokens with email_verified:false whose email the holder may not own), and the
// refresh-on-every-sign-in behavior nulls a previously stored email when a
// returning user's token flips to unverified.

import { test, expect } from 'bun:test';
import { getUserByOAuth, upsertOAuthUser } from '../src/lib/server/db';
import type { OAuthProfile } from '../src/lib/server/db';
import { freshDb } from './test-d1';

const profile = (overrides: Partial<OAuthProfile> = {}): OAuthProfile => ({
	email: 'holder@example.com',
	email_verified: true,
	name: 'Holder',
	picture: null,
	...overrides
});

test('first sign-in with a verified email stores it', async () => {
	const db = freshDb();
	const user = await upsertOAuthUser(db, 'google', 'sub-1', profile(), 0);

	expect(user.email).toBe('holder@example.com');
	expect(user.email_verified).toBe(true);

	const stored = await getUserByOAuth(db, 'google', 'sub-1');
	expect(stored?.email).toBe('holder@example.com');
});

test('first sign-in with an unverified email stores null, not the claim', async () => {
	const db = freshDb();
	const user = await upsertOAuthUser(db, 'google', 'sub-1', profile({ email_verified: false }), 0);

	expect(user.email).toBeNull();
	expect(user.email_verified).toBe(false);

	const stored = await getUserByOAuth(db, 'google', 'sub-1');
	expect(stored?.email).toBeNull();
});

test('a returning user whose token flips to unverified has the stored email nulled', async () => {
	const db = freshDb();
	await upsertOAuthUser(db, 'google', 'sub-1', profile(), 0);

	const user = await upsertOAuthUser(db, 'google', 'sub-1', profile({ email_verified: false }), 1);
	expect(user.email).toBeNull();

	const stored = await getUserByOAuth(db, 'google', 'sub-1');
	expect(stored?.email).toBeNull();
	expect(stored?.email_verified).toBe(false);
});

test('a returning user whose token re-verifies gets the email stored again', async () => {
	const db = freshDb();
	await upsertOAuthUser(db, 'google', 'sub-1', profile({ email_verified: false }), 0);

	const user = await upsertOAuthUser(db, 'google', 'sub-1', profile(), 1);
	expect(user.email).toBe('holder@example.com');

	const stored = await getUserByOAuth(db, 'google', 'sub-1');
	expect(stored?.email).toBe('holder@example.com');
	expect(stored?.email_verified).toBe(true);
});
