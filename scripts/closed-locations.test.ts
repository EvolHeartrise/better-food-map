// Exercises the permanently-closed soft-delete (migration 0015): a closed venue is
// hidden from every display/browse read, yet its row — and its user likes — survive,
// and it still blocks both re-creation and (via the unfiltered dedup read) re-listing.
import { test, expect } from 'bun:test';
import {
	insertLocations,
	setLocationClosed,
	getMapData,
	getLocationMapData,
	getStats,
	getLocationById,
	locationExists,
	getLocationsWithTags,
	existingLocationsAtCoords,
	coordinateKey,
	setLocationLike,
	getUserLikes,
	type LocationInsert
} from '../src/lib/server/db';
import { freshDb } from './test-d1';

/** A complete-address venue with sensible defaults; override per test. */
function venue(over: Partial<LocationInsert> & { name: string }): LocationInsert {
	return {
		category: 'cafe',
		latitude: 49.2,
		longitude: -123.1,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

const WIDE = { minLat: 49.0, maxLat: 49.5, minLng: -123.5, maxLng: -123.0 };

test('a born-closed location is hidden from reads but still blocks re-creation', async () => {
	const db = freshDb();
	const [openId, closedId] = await insertLocations(db, [
		venue({ name: 'Open Spot', latitude: 49.2, longitude: -123.1 }),
		venue({
			name: 'Closed Spot',
			latitude: 49.21,
			longitude: -123.11,
			closed_at: 1_700_000_000_000,
			closed_reason: 'Permanently closed per Yelp + dead website'
		})
	]);

	// Hidden from the single-detail read (queryMapData) and the viewport read.
	expect((await getLocationMapData(db, closedId)).locations).toHaveLength(0);
	expect((await getLocationMapData(db, openId)).locations.map((l) => l.id)).toEqual([openId]);
	const viewportIds = (await getMapData(db, WIDE)).locations.map((l) => l.id);
	expect(viewportIds).toContain(openId);
	expect(viewportIds).not.toContain(closedId);

	// Hidden from get_location and list_locations, and left out of coverage stats.
	expect(await getLocationById(db, closedId)).toBeNull();
	expect(await getLocationById(db, openId)).not.toBeNull();

	// The `/locations/<id>` 404 gate's existence probe agrees with the display
	// reads: open → true; closed or never-existed → false (both should 404).
	expect(await locationExists(db, openId)).toBe(true);
	expect(await locationExists(db, closedId)).toBe(false);
	expect(await locationExists(db, 'no-such-id')).toBe(false);
	const listedIds = (await getLocationsWithTags(db, {})).map((l) => l.id);
	expect(listedIds).toEqual([openId]);
	expect((await getStats(db)).locations).toBe(1);

	// But the row still exists for de-dup, so create_locations can't re-import the POI.
	const existing = await existingLocationsAtCoords(db, [{ latitude: 49.21, longitude: -123.11 }]);
	expect(existing.get(coordinateKey(49.21, -123.11))?.id).toBe(closedId);
});

test('soft-closing a live venue keeps its likes, then reopening restores it', async () => {
	const db = freshDb();
	const [id] = await insertLocations(db, [
		venue({ name: 'Likeable Cafe', latitude: 49.25, longitude: -123.15 })
	]);
	await db
		.prepare(`INSERT INTO users (id, email_verified, created_at) VALUES (?, 0, 0)`)
		.bind('u1')
		.run();
	await setLocationLike(db, 'u1', id, true, 123);

	// Live: visible everywhere and liked.
	expect(await getLocationById(db, id)).not.toBeNull();
	expect((await getStats(db)).locations).toBe(1);
	expect((await getUserLikes(db, 'u1')).locationIds).toEqual([id]);

	// Close it with a cited reason.
	const closed = await setLocationClosed(db, id, 1_700_000_000_000, 'Closed per owner notice', [
		{ url: 'https://example.com/closure', label: 'Closure notice' }
	]);
	expect(closed).toBe(true);

	// Hidden from every display read (and the 404 gate's probe tracks the close)...
	expect(await getLocationById(db, id)).toBeNull();
	expect(await locationExists(db, id)).toBe(false);
	expect((await getLocationMapData(db, id)).locations).toHaveLength(0);
	expect((await getStats(db)).locations).toBe(0);
	// ...but the like row survived (the whole point vs a hard delete).
	expect((await getUserLikes(db, 'u1')).locationIds).toEqual([id]);
	// ...and it still blocks re-creation at its coordinates.
	const existing = await existingLocationsAtCoords(db, [{ latitude: 49.25, longitude: -123.15 }]);
	expect(existing.get(coordinateKey(49.25, -123.15))?.id).toBe(id);

	// Reopen: back on the map, likes intact.
	expect(await setLocationClosed(db, id, null, null)).toBe(true);
	expect(await getLocationById(db, id)).not.toBeNull();
	expect(await locationExists(db, id)).toBe(true);
	expect((await getStats(db)).locations).toBe(1);
	expect((await getUserLikes(db, 'u1')).locationIds).toEqual([id]);
});

test('setLocationClosed reports not-found for an unknown id', async () => {
	const db = freshDb();
	expect(await setLocationClosed(db, 'does-not-exist', Date.now(), 'x')).toBe(false);
});
