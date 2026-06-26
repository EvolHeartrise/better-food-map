/// <reference types="bun-types" />
// Tests updateLocations (the batch behind the update_locations MCP tool) against
// the real SQLite schema via the in-memory D1Like adapter: partial patches, the
// replace-or-keep semantics of `sources`, and the unknown-id reporting that lets a
// mass backfill skip stragglers instead of aborting the whole batch.

import { test, expect } from 'bun:test';
import { insertLocations, updateLocations, getLocationById } from '../src/lib/server/db';
import { freshDb } from './test-d1';

const ADDR = {
	street: '1 Test St',
	city: 'Vancouver',
	region: 'BC',
	postcode: 'V6J 1M5',
	country: 'CA'
};

test('updateLocations applies patches in one batch and reports unknown ids', async () => {
	const db = freshDb();
	await insertLocations(db, [
		{
			id: 'a',
			name: 'A',
			category: 'cafe',
			latitude: 1,
			longitude: 1,
			...ADDR,
			phone: null,
			website: null,
			sources: [{ url: 'https://example.com/a', label: null }]
		},
		{
			id: 'b',
			name: 'B',
			category: 'cafe',
			latitude: 2,
			longitude: 2,
			...ADDR,
			phone: null,
			website: null
		}
	]);

	const res = await updateLocations(db, [
		{ id: 'a', name: 'A renamed', city: 'Burnaby', sources: [] },
		{ id: 'b', website: 'https://b.example' },
		{ id: 'missing', name: 'nope' }
	]);
	expect(res.updatedIds.toSorted()).toEqual(['a', 'b']);
	expect(res.notFoundIds).toEqual(['missing']);

	const la = await getLocationById(db, 'a');
	expect(la?.name).toBe('A renamed');
	expect(la?.city).toBe('Burnaby');
	expect(la?.sources).toEqual([]); // an explicit [] clears the source set

	const lb = await getLocationById(db, 'b');
	expect(lb?.website).toBe('https://b.example');
	expect(lb?.name).toBe('B'); // fields not in the patch are untouched
});

test('updateLocations leaves sources untouched when the patch omits them', async () => {
	const db = freshDb();
	await insertLocations(db, [
		{
			id: 's',
			name: 'S',
			category: null,
			latitude: 1,
			longitude: 1,
			...ADDR,
			phone: null,
			website: null,
			sources: [{ url: 'https://keep.example', label: 'keep' }]
		}
	]);

	await updateLocations(db, [{ id: 's', name: 'S2' }]);
	const loc = await getLocationById(db, 's');
	expect(loc?.name).toBe('S2');
	expect(loc?.sources).toEqual([{ url: 'https://keep.example', label: 'keep' }]);
});

test('updateLocations with only unknown ids touches nothing', async () => {
	const db = freshDb();
	const res = await updateLocations(db, [{ id: 'ghost', name: 'x' }]);
	expect(res.updatedIds).toEqual([]);
	expect(res.notFoundIds).toEqual(['ghost']);
});
