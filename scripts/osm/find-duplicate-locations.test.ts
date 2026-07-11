import { test, expect } from 'bun:test';
import { findDuplicateLocations } from './find-duplicate-locations';
import { type D1Like } from '../../src/lib/server/db';
import {
	auditDismissals,
	dismissAuditFinding,
	insertLocations,
	insertBrand,
	orderedPair,
	setLocationClosed,
	undismissAuditFinding
} from '../../src/lib/server/db-write';
import { freshDb } from '../test-d1';

const CHECK = 'duplicate_locations';

/** The audit exactly as the MCP handler runs it: stored dismissals injected. */
async function runAudit(db: D1Like, opts: Parameters<typeof findDuplicateLocations>[1] = {}) {
	return findDuplicateLocations(db, { ...opts, dismissals: await auditDismissals(db, CHECK) });
}

/** A pair's canonical dismissal subject (matches the audit's dismiss_key subject). */
function pairSubject(idA: string, idB: string): string {
	return orderedPair(idA, idB).join('|');
}

/** A minimal location insert; override per test. */
function loc(over: Record<string, unknown> = {}) {
	return {
		name: 'Venue',
		category: 'fast_food' as const,
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

async function seed(db: D1Like, rows: Record<string, unknown>[]) {
	return insertLocations(
		db,
		rows.map((r) => loc(r))
	);
}

test('flags same-name pairs within the radius, nearest first', async () => {
	const db = freshDb();
	await seed(db, [
		// ~8 m apart — the classic stale-OSM-node duplicate.
		{ name: 'Booster Juice', latitude: 43.8566898, longitude: -79.3335859 },
		{ name: 'Booster Juice', latitude: 43.8567497, longitude: -79.3335274 },
		// ~54 m apart, same name.
		{ name: 'Juice Stop', latitude: 43.6525771, longitude: -79.3790938 },
		{ name: 'Juice Stop', latitude: 43.6528256, longitude: -79.3785139 },
		// Same name but ~2 km apart — not flagged.
		{ name: 'Booster Juice', latitude: 43.876, longitude: -79.3335 },
		// Nearby but a different, unbranded venue — not flagged.
		{ name: 'Thai Palace', latitude: 43.85668, longitude: -79.33359 }
	]);
	const res = await findDuplicateLocations(db);
	expect(res.pairs.length).toBe(2);
	expect(res.pairs[0].a.name).toBe('Booster Juice'); // 8 m pair sorts first
	expect(res.pairs[0].distance_m).toBeLessThan(15);
	expect(res.pairs[0].names_match).toBe(true);
	expect(res.pairs[1].a.name).toBe('Juice Stop');
	expect(res.scanned).toBe(6);
});

test('flags same-brand pairs even when the names differ', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	await seed(db, [
		{ name: 'ChainCo', brand_id: brandId, latitude: 49.28, longitude: -123.12 },
		{ name: 'ChainCo Express', brand_id: brandId, latitude: 49.2801, longitude: -123.12 }
	]);
	const res = await findDuplicateLocations(db);
	expect(res.pairs.length).toBe(1);
	expect(res.pairs[0].same_brand).toBe(true);
});

test('ignores closed locations and honours limit/additional', async () => {
	const db = freshDb();
	const ids = await seed(db, [
		{ name: 'Twin', latitude: 49.28, longitude: -123.12 },
		{ name: 'Twin', latitude: 49.28005, longitude: -123.12 },
		{ name: 'Other Twin', latitude: 50.0, longitude: -120.0 },
		{ name: 'Other Twin', latitude: 50.0001, longitude: -120.0 }
	]);
	// Closing one half of a pair removes that pair from the audit.
	await setLocationClosed(db, ids[0], Date.now(), 'closed for test');
	const all = await findDuplicateLocations(db);
	expect(all.pairs.length).toBe(1);
	expect(all.pairs[0].a.name).toBe('Other Twin');

	const capped = await findDuplicateLocations(db, { limit: 0 });
	expect(capped.pairs.length).toBe(0);
	expect(capped.additional).toBe(1);
});

test('classifies confidence, matches phones by digits, and scopes by brand', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'ChainCo', website: null, logo_url: null });
	const otherBrand = await insertBrand(db, { name: 'OtherCo', website: null, logo_url: null });
	await seed(db, [
		// ~11 m apart, same name → high confidence.
		{ name: 'ChainCo', brand_id: brandId, latitude: 49.28, longitude: -123.12 },
		{ name: 'ChainCo', brand_id: brandId, latitude: 49.2801, longitude: -123.12 },
		// ~110 m apart but SAME PHONE (different formatting) → high confidence.
		{
			name: 'OtherCo',
			brand_id: otherBrand,
			latitude: 50.0,
			longitude: -120.0,
			phone: '+1 604-555-0100'
		},
		{
			name: 'OtherCo',
			brand_id: otherBrand,
			latitude: 50.001,
			longitude: -120.0,
			phone: '(604) 555 0100'
		},
		// ~110 m apart, same name, no phones → review.
		{ name: 'ChainCo', brand_id: brandId, latitude: 51.0, longitude: -114.0 },
		{ name: 'ChainCo', brand_id: brandId, latitude: 51.001, longitude: -114.0 }
	]);

	const all = await findDuplicateLocations(db);
	expect(all.pairs.length).toBe(3);
	const high = all.pairs.filter((p) => p.confidence === 'high');
	expect(high.length).toBe(2);
	expect(high.some((p) => p.same_phone)).toBe(true);
	expect(all.pairs.filter((p) => p.confidence === 'review').length).toBe(1);
	// Halves carry contact fields for verification.
	expect(high.every((p) => 'phone' in p.a && 'website' in p.b)).toBe(true);

	// Brand scoping: only pairs touching brandId.
	const scoped = await findDuplicateLocations(db, { brand_id: brandId });
	expect(scoped.pairs.length).toBe(2);
	expect(scoped.pairs.every((p) => p.a.brand_id === brandId || p.b.brand_id === brandId)).toBe(
		true
	);
});

test('dismissed pairs are suppressed, counted, surfaceable, and revocable', async () => {
	const db = freshDb();
	const [id1, id2] = await seed(db, [
		// ~8 m apart, same name — would normally flag.
		{ name: 'Booster Juice', latitude: 43.8566898, longitude: -79.3335859 },
		{ name: 'Booster Juice', latitude: 43.8567497, longitude: -79.3335274 },
		// A second, unrelated flagged pair that must keep flagging.
		{ name: 'Juice Stop', latitude: 43.6525771, longitude: -79.3790938 },
		{ name: 'Juice Stop', latitude: 43.6528256, longitude: -79.3785139 }
	]);

	const before = await runAudit(db);
	expect(before.pairs.length).toBe(2);
	expect(before.suppressed_dismissed).toBe(0);
	// Every pair carries the copyable dismissal handle.
	expect(before.pairs.every((p) => p.dismiss_key === `${pairSubject(p.a.id, p.b.id)}#`)).toBe(true);

	// Dismiss the Booster Juice pair as verified two-real-venues.
	const subject = pairSubject(id2, id1);
	const first = await dismissAuditFinding(db, CHECK, subject, '', 'own locator lists both units');
	expect(first.already_dismissed).toBe(false);

	const after = await runAudit(db);
	expect(after.pairs.length).toBe(1);
	expect(after.pairs[0].a.name).toBe('Juice Stop');
	expect(after.suppressed_dismissed).toBe(1);

	// include_dismissed surfaces the pair again, annotated with the verdict.
	const surfaced = await runAudit(db, { include_dismissed: true });
	expect(surfaced.pairs.length).toBe(2);
	expect(surfaced.suppressed_dismissed).toBe(1);
	const annotated = surfaced.pairs.filter((p) => p.dismissed);
	expect(annotated.length).toBe(1);
	expect(annotated[0].dismissed?.reason).toBe('own locator lists both units');

	// Re-dismissing is idempotent and reports the existing verdict.
	const again = await dismissAuditFinding(db, CHECK, subject, '', 'updated evidence');
	expect(again.already_dismissed).toBe(true);
	expect((await runAudit(db)).suppressed_dismissed).toBe(1);

	// Revoking restores the pair to the audit.
	expect(await undismissAuditFinding(db, CHECK, subject)).toBe(true);
	expect(await undismissAuditFinding(db, CHECK, subject)).toBe(false); // already gone
	const restored = await runAudit(db);
	expect(restored.pairs.length).toBe(2);
	expect(restored.suppressed_dismissed).toBe(0);
});

test('a dismissal goes inert when either location is deleted', async () => {
	const db = freshDb();
	const [id1, id2] = await seed(db, [
		{ name: 'Booster Juice', latitude: 43.8566898, longitude: -79.3335859 },
		{ name: 'Booster Juice', latitude: 43.8567497, longitude: -79.3335274 }
	]);
	await dismissAuditFinding(db, CHECK, pairSubject(id1, id2), '', 'verified');
	expect((await runAudit(db)).suppressed_dismissed).toBe(1);
	// Deleting one half (it was a duplicate after all) removes the pair itself,
	// so the stored dismissal matches nothing — inert, not counted.
	await db.prepare(`DELETE FROM locations WHERE id = ?`).bind(id2).run();
	const after = await runAudit(db);
	expect(after.pairs.length).toBe(0);
	expect(after.suppressed_dismissed).toBe(0);
});

test('migration 0025 carries legacy pair verdicts over as dismissals', async () => {
	// freshDb applies every migration, including the 0018 → 0025 data move; a
	// verdict inserted the OLD way must not exist as a table anymore.
	const db = freshDb();
	let threw = false;
	try {
		await db.prepare(`SELECT 1 FROM location_pair_reviews`).all();
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	const { results } = await db
		.prepare(`SELECT 1 AS x FROM sqlite_master WHERE name = 'audit_dismissals'`)
		.all();
	expect(results.length).toBe(1);
});

// --- staging-store phone fallback (same_phone_staging) -----------------------

import { OsmPoiStore } from './poi-store';
import type { PoiRow } from './map-feature';

function poiRow(over: Partial<PoiRow> & Pick<PoiRow, 'osm_id' | 'latitude' | 'longitude'>): PoiRow {
	return {
		osm_type: 'node',
		numeric_id: Number(over.osm_id.slice(1)) || 1,
		name: 'Venue',
		osm_class: 'restaurant',
		suggested_category: 'restaurant',
		cuisine: null,
		address: null,
		phone: null,
		website: null,
		opening_hours: null,
		diet_markers: [],
		admin_city: null,
		admin_region: null,
		tags_json: '{}',
		...over
	};
}

function stagingStore(rows: PoiRow[]): OsmPoiStore {
	const store = OsmPoiStore.open(':memory:');
	store.insertMany('test', rows);
	return store;
}

test('staging phones stand in for missing venue phones as same_phone_staging', async () => {
	const db = freshDb();
	const store = stagingStore([
		// Same phone under different formatting — often an Overture-enriched fill.
		poiRow({ osm_id: 'n1', latitude: 49.28, longitude: -123.12, phone: '+1 604-555-0100' }),
		poiRow({ osm_id: 'n2', latitude: 49.281, longitude: -123.12, phone: '(604) 555 0100' })
	]);
	await seed(db, [
		// ~110 m apart, same name, NO venue phones → review; staging phones agree.
		{ name: 'Twin', latitude: 49.28, longitude: -123.12, osm_id: 'n1' },
		{ name: 'Twin', latitude: 49.281, longitude: -123.12, osm_id: 'n2' }
	]);

	const res = await findDuplicateLocations(db, { store });
	expect(res.pairs.length).toBe(1);
	expect(res.pairs[0].same_phone).toBe(false); // the venue rows themselves carry none
	expect(res.pairs[0].same_phone_staging).toBe(true);
	// Staging evidence is weaker: it must NOT promote the pair to "high".
	expect(res.pairs[0].confidence).toBe('review');
	// Halves expose the osm_id the fallback resolved through.
	expect(res.pairs[0].a.osm_id).toBe('n1');

	// Without a store the flag is simply false — discovery is unchanged.
	const bare = await findDuplicateLocations(db);
	expect(bare.pairs.length).toBe(1);
	expect(bare.pairs[0].same_phone_staging).toBe(false);
	store.close();
});

test('a venue phone on one half compares against the staging phone of the other', async () => {
	const db = freshDb();
	const store = stagingStore([
		poiRow({ osm_id: 'n2', latitude: 50.001, longitude: -120.0, phone: '604 555 0100' })
	]);
	await seed(db, [
		{ name: 'Mixed', latitude: 50.0, longitude: -120.0, phone: '+1 (604) 555-0100' },
		{ name: 'Mixed', latitude: 50.001, longitude: -120.0, osm_id: 'n2' }
	]);
	const res = await findDuplicateLocations(db, { store });
	expect(res.pairs.length).toBe(1);
	expect(res.pairs[0].same_phone).toBe(false);
	expect(res.pairs[0].same_phone_staging).toBe(true);
	store.close();
});

test('the staging fallback never fires on disagreeing or unresolvable phones', async () => {
	const db = freshDb();
	const store = stagingStore([
		poiRow({ osm_id: 'n1', latitude: 49.28, longitude: -123.12, phone: '604 555 0100' }),
		poiRow({ osm_id: 'n2', latitude: 49.281, longitude: -123.12, phone: '604 555 0199' }),
		poiRow({ osm_id: 'n3', latitude: 51.0, longitude: -114.0, phone: '403 555 0100' }),
		poiRow({ osm_id: 'n4', latitude: 51.001, longitude: -114.0, phone: '403 555 0100' })
	]);
	await seed(db, [
		// Staging phones DIFFER → no hit.
		{ name: 'Twin A', latitude: 49.28, longitude: -123.12, osm_id: 'n1' },
		{ name: 'Twin A', latitude: 49.281, longitude: -123.12, osm_id: 'n2' },
		// Both venue rows carry their OWN, differing phones: that is already an
		// answer — the store's agreeing values must not overrule it.
		{ name: 'Twin B', latitude: 51.0, longitude: -114.0, phone: '403 555 0111', osm_id: 'n3' },
		{ name: 'Twin B', latitude: 51.001, longitude: -114.0, phone: '403 555 0122', osm_id: 'n4' },
		// No osm_id / not in the store on either half → unresolvable, no hit.
		{ name: 'Twin C', latitude: 52.0, longitude: -113.0 },
		{ name: 'Twin C', latitude: 52.001, longitude: -113.0, osm_id: 'n-missing' }
	]);
	const res = await findDuplicateLocations(db, { store });
	expect(res.pairs.length).toBe(3);
	expect(res.pairs.every((p) => !p.same_phone && !p.same_phone_staging)).toBe(true);
	store.close();
});

test('a venue-row phone match stays same_phone, not same_phone_staging', async () => {
	const db = freshDb();
	const store = stagingStore([]);
	await seed(db, [
		{ name: 'Twin', latitude: 49.28, longitude: -123.12, phone: '604 555 0100' },
		{ name: 'Twin', latitude: 49.281, longitude: -123.12, phone: '+1 604 555 0100' }
	]);
	const res = await findDuplicateLocations(db, { store });
	expect(res.pairs.length).toBe(1);
	expect(res.pairs[0].same_phone).toBe(true);
	expect(res.pairs[0].same_phone_staging).toBe(false);
	expect(res.pairs[0].confidence).toBe('high'); // venue-row phones still promote
	store.close();
});
