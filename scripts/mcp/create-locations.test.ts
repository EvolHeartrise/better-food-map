/// <reference types="bun-types" />
// Tests createLocationsBatch — the orchestration layer BETWEEN the create_locations
// / import_chain MCP tools and the db-write insertLocations primitive. Extracted
// from db-mcp-server.ts (which starts a stdio MCP server on import) so these
// semantics — id-skip idempotency, skip_invalid all-or-nothing vs per-row,
// coordinate-exact dedup (map + in-batch), near-duplicate same-name warnings, and
// osm_id coordinate/address resolution — run against the real migration schema via
// the in-memory D1 adapter without an MCP server. See finding #98.

import { test, expect } from 'bun:test';
import {
	getLocationById,
	getFoodByLocation,
	countLocations,
	insertBrand,
	insertMenu
} from '../../src/lib/server/db-write';
import { freshDb } from '../test-d1';
import type { StoredPoi } from '../osm/poi-store';
import {
	createLocationsBatch,
	type CreateLocationInput,
	type OsmStoreLike
} from './create-locations';

/** An OSM store returning the POIs it was seeded with by osm_id (else null). */
function fakeStore(pois: Record<string, StoredPoi>): OsmStoreLike {
	return { getByOsmId: (id) => pois[id] ?? null };
}

/** A store that must never be consulted (every item passes explicit coordinates). */
const noStore = fakeStore({});

/** A minimal StoredPoi; overrides win. addr:* tags feed the address fallback. */
function poi(over: Partial<StoredPoi> & { osm_id: string }): StoredPoi {
	return {
		osm_type: 'node',
		numeric_id: 1,
		name: 'Test POI',
		osm_class: 'amenity',
		suggested_category: 'restaurant',
		cuisine: null,
		latitude: 49.28,
		longitude: -123.12,
		address: null,
		phone: null,
		website: null,
		opening_hours: null,
		address_source: null,
		admin_city: null,
		admin_region: null,
		diet_markers: [],
		tags_json: '{}',
		region: 'CA',
		...over
	};
}

const ADDR = { street: '1 Test St', city: 'Vancouver', region: 'BC', country: 'CA' };

/** A valid independent-venue input at the given coordinates. */
function loc(name: string, latitude: number, longitude: number): CreateLocationInput {
	return { name, latitude, longitude, ...ADDR };
}

test('idempotency: re-running a batch with an already-created explicit id skips it', async () => {
	const db = freshDb();
	const item: CreateLocationInput = { id: 'loc-1', ...loc('Cafe One', 49.1, -123.1) };

	const first = await createLocationsBatch(db, noStore, [item]);
	expect(first.created).toBe(1);
	expect(first.location_ids).toEqual(['loc-1']);
	expect(first.skipped_existing_ids).toEqual([]);

	// A retry of the same call (e.g. after a partial failure) is a no-op, not a
	// primary-key collision.
	const retry = await createLocationsBatch(db, noStore, [
		item,
		{ id: 'loc-2', ...loc('Cafe Two', 49.2, -123.2) }
	]);
	expect(retry.created).toBe(1);
	expect(retry.location_ids).toEqual(['loc-2']);
	expect(retry.skipped_existing_ids).toEqual(['loc-1']);
	expect(await countLocations(db)).toBe(2);
});

test('skip_invalid=false is all-or-nothing: one invalid row writes nothing', async () => {
	const db = freshDb();
	const items: CreateLocationInput[] = [
		loc('Good', 49.1, -123.1),
		// No coordinates and no osm_id → unresolvable.
		{ name: 'Bad', ...ADDR }
	];

	expect(createLocationsBatch(db, noStore, items)).rejects.toThrow(/1 of 2 item\(s\) are invalid/);
	expect(await countLocations(db)).toBe(0);
});

test('skip_invalid=true creates the valid rows and reports the rest per-row', async () => {
	const db = freshDb();
	const items: CreateLocationInput[] = [loc('Good', 49.1, -123.1), { name: 'Bad', ...ADDR }];

	const res = await createLocationsBatch(db, noStore, items, { skipInvalid: true });
	expect(res.created).toBe(1);
	expect(res.skipped_invalid).toHaveLength(1);
	expect(res.skipped_invalid?.[0].name).toBe('Bad');
	expect(res.skipped_invalid?.[0].reason).toMatch(/latitude and longitude are required/);
	expect(await countLocations(db)).toBe(1);
});

test('in-batch coordinate-exact dedup: a repeated point is skipped (existing_id null)', async () => {
	const db = freshDb();
	const res = await createLocationsBatch(db, noStore, [
		loc('First', 49.28, -123.12),
		loc('Second (same spot)', 49.28, -123.12)
	]);
	expect(res.created).toBe(1);
	expect(res.skipped_duplicate_locations).toEqual([
		{ name: 'Second (same spot)', existing_id: null }
	]);
});

test('map coordinate-exact dedup: a point matching a stored venue is skipped with its id', async () => {
	const db = freshDb();
	const seed = await createLocationsBatch(db, noStore, [
		{ id: 'seed-1', ...loc('Already Here', 49.28, -123.12) }
	]);
	expect(seed.created).toBe(1);

	const res = await createLocationsBatch(db, noStore, [loc('Duplicate', 49.28, -123.12)]);
	expect(res.created).toBe(0);
	expect(res.skipped_duplicate_locations).toEqual([{ name: 'Duplicate', existing_id: 'seed-1' }]);
});

test('near-duplicate warning fires for a same-name venue within ~150 m, not beyond', async () => {
	const db = freshDb();
	await createLocationsBatch(db, noStore, [loc('Pizza Place', 49.28, -123.12)]);

	// ~100 m north (0.0009° lat ≈ 100 m) — inside the threshold.
	const near = await createLocationsBatch(db, noStore, [loc('Pizza Place', 49.2809, -123.12)]);
	expect(near.created).toBe(1);
	expect(near.warnings?.some((w) => w.includes('same-name location'))).toBe(true);

	// ~330 m north (0.003° lat) — outside the threshold, no warning.
	const far = await createLocationsBatch(db, noStore, [loc('Pizza Place', 49.283, -123.12)]);
	expect(far.warnings).toBeUndefined();

	// A DIFFERENT name at a near-duplicate distance is not flagged.
	const other = await createLocationsBatch(db, noStore, [loc('Sushi Bar', 49.2809, -123.12)]);
	expect(other.warnings).toBeUndefined();
});

test('osm_id resolves coordinates verbatim from the POI and falls back to its addr:* tags', async () => {
	const db = freshDb();
	const store = fakeStore({
		'node/42': poi({
			osm_id: 'node/42',
			latitude: 45.5017,
			longitude: -73.5673,
			suggested_category: 'cafe',
			tags_json: JSON.stringify({
				'addr:housenumber': '100',
				'addr:street': 'Rue Sainte-Catherine',
				'addr:city': 'Montreal',
				'addr:state': 'QC',
				'addr:postcode': 'H2X 1Z4'
			})
		})
	});

	const res = await createLocationsBatch(db, store, [{ name: 'Cafe OSM', osm_id: 'node/42' }]);
	expect(res.created).toBe(1);
	const stored = await getLocationById(db, res.location_ids[0]);
	expect(stored?.latitude).toBe(45.5017);
	expect(stored?.longitude).toBe(-73.5673);
	expect(stored?.category).toBe('cafe');
	expect(stored?.street).toBe('100 Rue Sainte-Catherine');
	expect(stored?.region).toBe('QC');
});

test('passing latitude/longitude together with osm_id is rejected', async () => {
	const db = freshDb();
	const store = fakeStore({ 'node/42': poi({ osm_id: 'node/42' }) });
	const res = await createLocationsBatch(
		db,
		store,
		[{ name: 'Conflict', osm_id: 'node/42', latitude: 1, longitude: 2 }],
		{ skipInvalid: true }
	);
	expect(res.created).toBe(0);
	expect(res.skipped_invalid?.[0].reason).toMatch(
		/do not pass latitude\/longitude together with osm_id/
	);
});

test('an unknown osm_id is an invalid row, not a crash', async () => {
	const db = freshDb();
	const res = await createLocationsBatch(db, noStore, [{ name: 'Ghost', osm_id: 'node/999' }], {
		skipInvalid: true
	});
	expect(res.created).toBe(0);
	expect(res.skipped_invalid?.[0].reason).toMatch(/No OSM POI "node\/999" in the staging store/);
});

test('inline menu_items require a source and build the private menu', async () => {
	const db = freshDb();
	// No sources → rejected (menu-level provenance rule).
	const missing = await createLocationsBatch(
		db,
		noStore,
		[
			{
				...loc('No Source', 49.1, -123.1),
				menu_items: [{ item_name: 'Soup', tags: ['food'] }]
			}
		],
		{ skipInvalid: true }
	);
	expect(missing.created).toBe(0);
	expect(missing.skipped_invalid?.[0].reason).toMatch(/at least one source link is required/);

	// With a source → the item lands on the venue's private menu.
	const res = await createLocationsBatch(db, noStore, [
		{
			...loc('With Source', 49.1, -123.1),
			sources: [{ url: 'https://example.com/menu' }],
			menu_items: [{ item_name: 'Soup', price: 5, tags: ['food'] }]
		}
	]);
	expect(res.created).toBe(1);
	expect(res.items_created).toBe(1);
	const items = await getFoodByLocation(db, res.location_ids[0]);
	expect(items.map((i) => i.item_name)).toEqual(['Soup']);
});

test('inline menu_items on a chain-linked branch are rejected', async () => {
	const db = freshDb();
	// The brand/menu refs are validated up front, so they must actually exist —
	// the conflict we exercise is menu_items + a chain link, not a bad ref.
	await insertBrand(db, { id: 'brand-x', name: 'Chain X', website: null, logo_url: null });
	await insertMenu(db, { id: 'menu-x', name: 'Chain X CA', brand_id: 'brand-x', region: 'CA' });

	const res = await createLocationsBatch(
		db,
		noStore,
		[
			{
				...loc('Branch', 49.1, -123.1),
				brand_id: 'brand-x',
				menu_id: 'menu-x',
				sources: [{ url: 'https://example.com/menu' }],
				menu_items: [{ item_name: 'Sub', tags: ['food'] }]
			}
		],
		{ skipInvalid: true }
	);
	expect(res.created).toBe(0);
	expect(res.skipped_invalid?.[0].reason).toMatch(/has `menu_items` but is linked to a chain/);
});
