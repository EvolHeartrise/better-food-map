/// <reference types="bun-types" />
// Tests deleteLocationsBatch — the delete_locations tool's core: hard-delete a
// batch of location ids, partitioning them into deleted vs not-found. Runs against
// the real migration schema via the in-memory D1 adapter.

import { test, expect } from 'bun:test';
import { insertLocations, getLocationById } from '../../src/lib/server/db';
import { freshDb } from '../test-d1';
import { deleteLocationsBatch } from './delete-locations';

function loc(over: Record<string, unknown> = {}) {
	return {
		name: 'X',
		category: 'cafe' as const,
		latitude: 49.28,
		longitude: -123.12,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: null,
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

test('deletes existing ids and reports missing ones', async () => {
	const db = freshDb();
	const [a, b] = await insertLocations(db, [loc({ latitude: 49.1 }), loc({ latitude: 49.2 })]);

	const res = await deleteLocationsBatch(db, [a, 'missing-id', b]);
	expect(res.deleted).toBe(2);
	expect(res.deleted_ids.toSorted()).toEqual([a, b].toSorted());
	expect(res.not_found_ids).toEqual(['missing-id']);

	// Both rows are actually gone.
	expect(await getLocationById(db, a)).toBeNull();
	expect(await getLocationById(db, b)).toBeNull();
});

test('a repeated id lands in exactly one bucket (deduped)', async () => {
	const db = freshDb();
	const [a] = await insertLocations(db, [loc()]);
	const res = await deleteLocationsBatch(db, [a, a]);
	expect(res.deleted).toBe(1);
	expect(res.deleted_ids).toEqual([a]);
	expect(res.not_found_ids).toEqual([]);
});
