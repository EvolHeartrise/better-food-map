// ---------------------------------------------------------------------------
// Unit tests for the closure-signals planning core, against SYNTHETIC snapshot
// fixtures. Deliberate: only ONE real Overture release exists on disk (issue
// #304 starts keeping pairs from the next release), so a release-pair test can
// only be synthetic — which also pins the exact edge semantics (the id-churn
// downgrade, the ≥-drop threshold, multi-signal POIs) far better than two real
// 500k-row files would.
// ---------------------------------------------------------------------------

import { test, expect } from 'bun:test';
import {
	DEFAULT_CONFIDENCE_DROP,
	buildWorklist,
	planClosureSignals,
	toSnapshotPlace,
	type BankedPoi,
	type LocationRef,
	type SnapshotPlace
} from './closure-signals';

function poi(over: Partial<BankedPoi> & Pick<BankedPoi, 'osm_id' | 'overture_id'>): BankedPoi {
	return { name: 'Test Venue', latitude: 49.28, longitude: -123.12, ...over };
}

function place(over: Partial<SnapshotPlace> & Pick<SnapshotPlace, 'id'>): SnapshotPlace {
	return {
		name: 'Test Venue',
		latitude: 49.28,
		longitude: -123.12,
		confidence: 0.9,
		operating_status: null,
		...over
	};
}

test('an id present in old and absent from new is gone', async () => {
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-1' })],
		[place({ id: 'ov-1', confidence: 0.95 })],
		[]
	);
	expect(plan.signals.length).toBe(1);
	const s = plan.signals[0];
	expect(s.signal).toBe('gone');
	expect(s.osm_id).toBe('n1');
	expect(s.overture_id).toBe('ov-1');
	expect(s.overture_name).toBe('Test Venue');
	expect(s.evidence).toEqual({
		old_confidence: 0.95,
		new_confidence: null,
		old_status: null,
		new_status: null
	});
	expect(plan.counts).toEqual({
		banked: 1,
		in_old: 1,
		in_new: 0,
		in_neither: 0,
		gone: 1,
		id_churn: 0,
		confidence_collapse: 0,
		status_closed: 0
	});
});

test('a gone id that reappears nearby under a new id with a related name downgrades to id_churn', async () => {
	// Same spot (~15 m), name-related ("Test Venue" vs "The Test Venue"), new id:
	// the Nov-2025 GERS churn pattern, NOT a closure.
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-old' })],
		[place({ id: 'ov-old', confidence: 0.9 })],
		[
			place({
				id: 'ov-new',
				name: 'The Test Venue',
				latitude: 49.28013,
				confidence: 0.88,
				operating_status: 'open'
			})
		]
	);
	expect(plan.signals.length).toBe(1);
	const s = plan.signals[0];
	expect(s.signal).toBe('id_churn');
	expect(s.evidence.churn_candidate).toMatchObject({
		overture_id: 'ov-new',
		name: 'The Test Venue',
		confidence: 0.88,
		operating_status: 'open'
	});
	expect(s.evidence.churn_candidate?.distance_m).toBeGreaterThan(5);
	expect(s.evidence.churn_candidate?.distance_m).toBeLessThan(30);
	expect(plan.counts.id_churn).toBe(1);
	expect(plan.counts.gone).toBe(0);
});

test('a same-spot new place with an UNRELATED name does not save a gone id', async () => {
	// A new occupant at the address is closure evidence, not churn.
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-old', name: 'Olde Diner' })],
		[place({ id: 'ov-old', name: 'Olde Diner' })],
		[place({ id: 'ov-new', name: 'Sushi Palace' })]
	);
	expect(plan.signals.map((s) => s.signal)).toEqual(['gone']);
});

test('a name-related new place BEYOND the churn radius does not save a gone id', async () => {
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-old' })],
		[place({ id: 'ov-old' })],
		[place({ id: 'ov-new', latitude: 49.285 })] // ~550 m away
	);
	expect(plan.signals.map((s) => s.signal)).toEqual(['gone']);
});

test('confidence collapse fires at the ≥0.2 threshold, not below it', async () => {
	const plan = await planClosureSignals(
		[
			poi({ osm_id: 'n1', overture_id: 'ov-1' }),
			poi({ osm_id: 'n2', overture_id: 'ov-2' }),
			poi({ osm_id: 'n3', overture_id: 'ov-3' })
		],
		[
			place({ id: 'ov-1', confidence: 0.95 }),
			place({ id: 'ov-2', confidence: 0.9 }),
			place({ id: 'ov-3', confidence: null }) // no old confidence → no diff
		],
		[
			place({ id: 'ov-1', confidence: 0.6 }), // drop 0.35 → flagged
			place({ id: 'ov-2', confidence: 0.75 }), // drop 0.15 → not flagged
			place({ id: 'ov-3', confidence: 0.1 })
		]
	);
	expect(plan.signals.length).toBe(1);
	expect(plan.signals[0].signal).toBe('confidence_collapse');
	expect(plan.signals[0].osm_id).toBe('n1');
	expect(plan.signals[0].evidence.old_confidence).toBe(0.95);
	expect(plan.signals[0].evidence.new_confidence).toBe(0.6);
	expect(DEFAULT_CONFIDENCE_DROP).toBe(0.2);
});

test('permanently_closed in the new snapshot flags status_closed, and can co-fire with a collapse', async () => {
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-1' }), poi({ osm_id: 'n2', overture_id: 'ov-2' })],
		[place({ id: 'ov-1', confidence: 0.9 }), place({ id: 'ov-2', confidence: 0.9 })],
		[
			// Closed AND collapsed: one entry per signal, same evidence.
			place({ id: 'ov-1', confidence: 0.4, operating_status: 'permanently_closed' }),
			// temporarily_closed is NOT a closure signal.
			place({ id: 'ov-2', confidence: 0.9, operating_status: 'temporarily_closed' })
		]
	);
	expect(plan.signals.map((s) => s.signal).toSorted()).toEqual([
		'confidence_collapse',
		'status_closed'
	]);
	expect(plan.signals.every((s) => s.osm_id === 'n1')).toBe(true);
	const closed = plan.signals.find((s) => s.signal === 'status_closed');
	expect(closed?.evidence.new_status).toBe('permanently_closed');
});

test('status_closed fires even when the id is missing from the old snapshot', async () => {
	// The bank may postdate --old; --new saying permanently_closed is evidence
	// regardless of the diff.
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-1' })],
		[],
		[place({ id: 'ov-1', operating_status: 'permanently_closed' })]
	);
	expect(plan.signals.map((s) => s.signal)).toEqual(['status_closed']);
	expect(plan.counts.in_old).toBe(0);
	expect(plan.counts.in_new).toBe(1);
});

test('an id in neither snapshot is counted unevaluable, never flagged', async () => {
	const plan = await planClosureSignals([poi({ osm_id: 'n1', overture_id: 'ov-x' })], [], []);
	expect(plan.signals.length).toBe(0);
	expect(plan.counts.in_neither).toBe(1);
});

test('a stable id with steady confidence produces no signal', async () => {
	const plan = await planClosureSignals(
		[poi({ osm_id: 'n1', overture_id: 'ov-1' })],
		[place({ id: 'ov-1', confidence: 0.9, operating_status: 'open' })],
		[place({ id: 'ov-1', confidence: 0.88, operating_status: 'open' })]
	);
	expect(plan.signals.length).toBe(0);
});

test('buildWorklist buckets signals by venue disposition and signal type', async () => {
	const plan = await planClosureSignals(
		[
			poi({ osm_id: 'n-live', overture_id: 'ov-1' }),
			poi({ osm_id: 'n-closed', overture_id: 'ov-2', latitude: 50.0 }),
			poi({ osm_id: 'n-staging', overture_id: 'ov-3', latitude: 51.0 })
		],
		[
			place({ id: 'ov-1' }),
			place({ id: 'ov-2', latitude: 50.0 }),
			place({ id: 'ov-3', latitude: 51.0 })
		],
		[] // all three gone (no name-related replacements anywhere near)
	);
	const locations = new Map<string, LocationRef>([
		['n-live', { id: 'loc-1', name: 'Live Venue', closed: false }],
		['n-closed', { id: 'loc-2', name: 'Tombstone', closed: true }]
	]);
	const worklist = buildWorklist(plan, locations, {
		oldSnapshot: 'old.ndjson',
		newSnapshot: 'new.ndjson',
		confidenceDrop: 0.2,
		churnRadiusM: 100,
		generatedAt: '2026-07-10T00:00:00.000Z'
	});

	expect(worklist.counts.live_location).toBe(1);
	expect(worklist.counts.already_closed_location).toBe(1);
	expect(worklist.counts.staging_only).toBe(1);
	expect(worklist.live.gone.length).toBe(1);
	expect(worklist.live.gone[0].location).toEqual({ id: 'loc-1', name: 'Live Venue' });
	expect(worklist.already_closed.gone[0].location).toEqual({ id: 'loc-2', name: 'Tombstone' });
	expect(worklist.staging_only.gone[0].osm_id).toBe('n-staging');
	expect(worklist.staging_only.gone[0].location).toBeUndefined();
	// Empty groups are present (stable shape for consumers).
	expect(worklist.live.status_closed).toEqual([]);
	expect(worklist.generated_at).toBe('2026-07-10T00:00:00.000Z');
	expect(worklist.old_snapshot).toBe('old.ndjson');
});

test('toSnapshotPlace parses the eateries NDJSON line shape and rejects junk', () => {
	expect(
		toSnapshotPlace({
			id: 'ov-1',
			name: 'Old Agness Store',
			lon: -124.42,
			lat: 42.4,
			confidence: 0.96,
			operating_status: 'open',
			category: 'bakery' // extra fields ride through ignored
		})
	).toEqual({
		id: 'ov-1',
		name: 'Old Agness Store',
		latitude: 42.4,
		longitude: -124.42,
		confidence: 0.96,
		operating_status: 'open'
	});
	// Nulls where the feed has gaps.
	expect(toSnapshotPlace({ id: 'ov-2', lon: 0, lat: 0 })).toEqual({
		id: 'ov-2',
		name: null,
		latitude: 0,
		longitude: 0,
		confidence: null,
		operating_status: null
	});
	expect(toSnapshotPlace({ name: 'no id', lon: 0, lat: 0 })).toBeNull();
	expect(toSnapshotPlace({ id: 'ov-3', lon: 'x', lat: 0 })).toBeNull();
	expect(toSnapshotPlace('not an object')).toBeNull();
	expect(toSnapshotPlace(null)).toBeNull();
});
