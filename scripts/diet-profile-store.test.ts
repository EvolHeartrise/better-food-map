/// <reference types="bun-types" />
// Exercises the SERVER side of the dietary profile against the real migration
// schema via the in-memory D1Like adapter: getUserDiet / setUserDiet — the per-user
// single-diet upsert round-trip (migration 0014 reshaped the profile from
// restriction/allergen arrays to one `diet` tag id). The pure client-side
// vocabulary (DIET_OPTIONS / sanitizeDiet) is covered in diet-profile.test.ts.

import { test, expect } from 'bun:test';
import { getUserDiet, setUserDiet } from '../src/lib/server/db';
import { freshDb } from './test-d1';

test('getUserDiet / setUserDiet: round-trips, clears, and upserts per user', async () => {
	const db = freshDb();
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();

	// No row yet → no diet.
	expect(await getUserDiet(db, 'u1')).toBeNull();

	await setUserDiet(db, 'u1', 'vegan', 1000);
	expect(await getUserDiet(db, 'u1')).toBe('vegan');

	// A second save for the same user overwrites (upsert), not duplicates.
	await setUserDiet(db, 'u1', 'halal', 2000);
	expect(await getUserDiet(db, 'u1')).toBe('halal');

	// Clearing the diet stores NULL.
	await setUserDiet(db, 'u1', null, 3000);
	expect(await getUserDiet(db, 'u1')).toBeNull();

	const { results } = await db
		.prepare(`SELECT COUNT(*) AS n FROM user_dietary_profile WHERE user_id = 'u1'`)
		.all<{ n: number }>();
	expect(results[0].n).toBe(1);
});
