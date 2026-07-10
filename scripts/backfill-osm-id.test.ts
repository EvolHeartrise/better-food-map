/// <reference types="bun-types" />
// Tests planBackfill — the matching core of the osm_id backfill: only unstamped
// locations with exactly ONE coordinate-exact, name-matching, unclaimed staging
// POI are stamped; every ambiguity is reported (never guessed between).

import { test, expect } from 'bun:test';
import { planBackfill, type LiveLocation } from './backfill-osm-id';

interface FakePoi {
	osm_id: string;
	name: string | null;
	latitude: number;
	longitude: number;
}

/** In-memory stand-in for OsmPoiStore.searchBbox (bbox filter only, like the real probe). */
function fakeStore(pois: FakePoi[]) {
	return {
		searchBbox: (bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number }) =>
			pois.filter(
				(p) =>
					p.latitude >= bbox.minLat &&
					p.latitude <= bbox.maxLat &&
					p.longitude >= bbox.minLng &&
					p.longitude <= bbox.maxLng
			)
	};
}

function loc(over: Partial<LiveLocation> & { id: string }): LiveLocation {
	return {
		name: 'Cafe',
		latitude: 49.1,
		longitude: -123.1,
		osm_id: null,
		closed_at: null,
		...over
	};
}

test('stamps only unstamped locations with a single exact, name-matching POI', () => {
	const store = fakeStore([
		{ osm_id: 'node/1', name: 'Cafe', latitude: 49.1, longitude: -123.1 },
		// nearby but NOT coordinate-identical: never matched
		{ osm_id: 'node/2', name: 'Cafe', latitude: 49.1000002, longitude: -123.1 }
	]);
	const plan = planBackfill([loc({ id: 'a' })], store);
	expect(plan.assignments).toEqual([{ id: 'a', osm_id: 'node/1' }]);
	expect(plan.poiConflicts).toEqual([]);
});

test('never clobbers an osm_id a location already has', () => {
	const store = fakeStore([{ osm_id: 'node/1', name: 'Cafe', latitude: 49.1, longitude: -123.1 }]);
	const plan = planBackfill([loc({ id: 'a', osm_id: 'node/9' })], store);
	expect(plan.assignments).toEqual([]);
	expect(plan.alreadyHave).toBe(1);
});

test('report buckets: no exact POI (closed flagged), double-mapping, name mismatch', () => {
	const store = fakeStore([
		{ osm_id: 'node/1', name: 'Cafe', latitude: 49.2, longitude: -123.2 },
		{ osm_id: 'node/2', name: 'Cafe', latitude: 49.2, longitude: -123.2 },
		{ osm_id: 'node/3', name: 'New Occupant Ramen', latitude: 49.3, longitude: -123.3 }
	]);
	const plan = planBackfill(
		[
			loc({ id: 'nowhere', latitude: 48.0, longitude: -120.0 }),
			loc({ id: 'tomb', latitude: 48.5, longitude: -121.0, closed_at: 1750000000000 }),
			loc({ id: 'doubled', latitude: 49.2, longitude: -123.2 }),
			loc({ id: 'renamed', latitude: 49.3, longitude: -123.3 })
		],
		store
	);
	expect(plan.assignments).toEqual([]);
	expect(plan.noExactPoi).toEqual([
		{ id: 'nowhere', name: 'Cafe', closed: false },
		{ id: 'tomb', name: 'Cafe', closed: true }
	]);
	expect(plan.multiPoi).toEqual([{ id: 'doubled', name: 'Cafe', osm_ids: ['node/1', 'node/2'] }]);
	expect(plan.nameMismatches).toEqual([
		{ id: 'renamed', name: 'Cafe', poi_name: 'New Occupant Ramen', osm_id: 'node/3' }
	]);
});

test('a POI claimed by two locations is withheld and reported loudly', () => {
	// Two rows at one point should be impossible under coordinate-exact dedup;
	// if it happens anyway, neither may be stamped.
	const store = fakeStore([{ osm_id: 'node/1', name: 'Cafe', latitude: 49.1, longitude: -123.1 }]);
	const plan = planBackfill([loc({ id: 'a' }), loc({ id: 'b' })], store);
	expect(plan.assignments).toEqual([]);
	expect(plan.poiConflicts).toEqual([{ osm_id: 'node/1', location_ids: ['a', 'b'] }]);
});

test('a pre-existing stamp counts as a claim: a second claimant conflicts, not stamps', () => {
	const store = fakeStore([{ osm_id: 'node/1', name: 'Cafe', latitude: 49.1, longitude: -123.1 }]);
	const plan = planBackfill(
		[loc({ id: 'stamped', osm_id: 'node/1', latitude: 49.5, longitude: -124.0 }), loc({ id: 'b' })],
		store
	);
	expect(plan.assignments).toEqual([]);
	expect(plan.alreadyHave).toBe(1);
	expect(plan.poiConflicts).toEqual([{ osm_id: 'node/1', location_ids: ['stamped', 'b'] }]);
});
