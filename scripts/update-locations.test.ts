/// <reference types="bun-types" />
// Tests updateLocations (the batch behind the update_locations MCP tool) against
// the real SQLite schema via the in-memory D1Like adapter: partial patches, and the
// unknown-id reporting that lets a mass backfill skip stragglers instead of aborting
// the whole batch. Provenance is menu-level, so a location patch never touches sources.

import { test, expect } from 'bun:test';
import {
	insertLocations,
	updateLocations,
	getLocationById,
	getMenuById
} from '../src/lib/server/db';
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
			website: null
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
		{ id: 'a', name: 'A renamed', city: 'Burnaby' },
		{ id: 'b', website: 'https://b.example' },
		{ id: 'missing', name: 'nope' }
	]);
	expect(res.updatedIds.toSorted()).toEqual(['a', 'b']);
	expect(res.notFoundIds).toEqual(['missing']);

	const la = await getLocationById(db, 'a');
	expect(la?.name).toBe('A renamed');
	expect(la?.city).toBe('Burnaby');

	const lb = await getLocationById(db, 'b');
	expect(lb?.website).toBe('https://b.example');
	expect(lb?.name).toBe('B'); // fields not in the patch are untouched
});

test('updateLocations leaves the venue menu sources untouched', async () => {
	const db = freshDb();
	// An independent venue with an inline menu carries its provenance on its private menu.
	const [id] = await insertLocations(db, [
		{
			name: 'S',
			category: null,
			latitude: 1,
			longitude: 1,
			...ADDR,
			phone: null,
			website: null,
			menuSources: [{ url: 'https://keep.example', label: 'keep' }],
			items: [{ item_name: 'Soup', price: 5 }]
		}
	]);

	await updateLocations(db, [{ id, name: 'S2' }]);
	const loc = await getLocationById(db, id);
	expect(loc?.name).toBe('S2');
	// The location patch never touches provenance — the menu keeps its sources.
	const menu = await getMenuById(db, `pm-${id}`);
	expect(menu?.sources).toEqual([{ url: 'https://keep.example', label: 'keep' }]);
});

test('updateLocations with only unknown ids touches nothing', async () => {
	const db = freshDb();
	const res = await updateLocations(db, [{ id: 'ghost', name: 'x' }]);
	expect(res.updatedIds).toEqual([]);
	expect(res.notFoundIds).toEqual(['ghost']);
});
