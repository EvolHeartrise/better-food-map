/// <reference types="bun-types" />
// Tests planBackfill — the matching core of the opening-hours backfill: only
// hours-less locations with a coordinate-EXACT, name-matching staging POI that
// carries hours are patched; everything else lands in the census buckets.

import { test, expect } from 'bun:test';
import { planBackfill, type LiveLocation } from './backfill-opening-hours';

interface FakePoi {
	name: string | null;
	latitude: number;
	longitude: number;
	opening_hours: string | null;
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
	return { name: 'Cafe', latitude: 49.1, longitude: -123.1, opening_hours: null, ...over };
}

test('patches only hours-less locations with an exact, name-matching, hours-tagged POI', () => {
	const store = fakeStore([
		{ name: 'Cafe', latitude: 49.1, longitude: -123.1, opening_hours: 'Mo-Fr 09:00-17:00' },
		// nearby but NOT coordinate-identical: never matched
		{ name: 'Cafe', latitude: 49.1000002, longitude: -123.1, opening_hours: 'Mo-Su 08:00-20:00' }
	]);
	const plan = planBackfill([loc({ id: 'a' })], store);
	expect(plan.patches).toEqual([{ id: 'a', opening_hours: 'Mo-Fr 09:00-17:00' }]);
	expect(plan.rawOnly).toBe(0);
});

test('never clobbers hours a location already has', () => {
	const store = fakeStore([
		{ name: 'Cafe', latitude: 49.1, longitude: -123.1, opening_hours: 'Mo-Fr 09:00-17:00' }
	]);
	const plan = planBackfill([loc({ id: 'a', opening_hours: 'Mo-Su 10:00-22:00' })], store);
	expect(plan.patches).toEqual([]);
	expect(plan.alreadyHave).toBe(1);
});

test('census buckets: no exact POI, POI without hours, name mismatch', () => {
	const store = fakeStore([
		{ name: 'Cafe', latitude: 49.2, longitude: -123.2, opening_hours: null },
		{ name: 'New Occupant Ramen', latitude: 49.3, longitude: -123.3, opening_hours: '24/7' }
	]);
	const plan = planBackfill(
		[
			loc({ id: 'nowhere', latitude: 48.0, longitude: -120.0 }),
			loc({ id: 'no-hours', latitude: 49.2, longitude: -123.2 }),
			loc({ id: 'renamed', latitude: 49.3, longitude: -123.3 })
		],
		store
	);
	expect(plan.patches).toEqual([]);
	expect(plan.noExactPoi).toBe(1);
	expect(plan.poiWithoutHours).toBe(1);
	expect(plan.nameMismatches).toEqual([
		{ id: 'renamed', name: 'Cafe', poi_name: 'New Occupant Ramen' }
	]);
});

test('two OSM nodes at one point: the one with hours wins; raw-only values are counted', () => {
	const store = fakeStore([
		{ name: 'Cafe', latitude: 49.1, longitude: -123.1, opening_hours: null },
		{ name: 'Cafe', latitude: 49.1, longitude: -123.1, opening_hours: 'Mo-Su sunrise-sunset' }
	]);
	const plan = planBackfill([loc({ id: 'a' })], store);
	expect(plan.patches).toEqual([{ id: 'a', opening_hours: 'Mo-Su sunrise-sunset' }]);
	expect(plan.rawOnly).toBe(1);
});
