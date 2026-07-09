/// <reference types="bun-types" />
// DOM-free tests of the map page's viewport-data orchestration
// ($lib/viewport-data.svelte.ts): the debounced filter commit, the per-cell
// fetch with in-flight dedup, and the searching/fetchFailed status invariants
// PR #208 documented — filter-change supersession, the filtered-fetch
// in-flight COUNT (a stale browse failure must not kill a live search's
// spinner), and the failure-kind relevance gate (a failure is only flagged
// while it still describes what's on screen).
//
// The module is a `.svelte.ts` runes module; bun runs it untransformed, so
// give `$state` its identity semantics up front — the class fields become
// plain (non-reactive) values, which is exactly what logic tests need. The
// remote query is injected (FetchMapCells), so it's a plain mock here.
import { test, expect, describe } from 'bun:test';

(globalThis as unknown as { $state: <T>(v: T) => T }).$state = <T>(v: T) => v;
const { ViewportData, SEARCH_DEBOUNCE_MS, EMPTY_MAP_DATA } =
	await import('../src/lib/viewport-data.svelte');
const { cellKey, cellsForBounds, levelCell, levelForBounds } = await import('../src/lib/grid');
import type { Bounds, MapCellsData } from '../src/lib/server/db';

// sync() logs failed fetches via console.error; keep the test output clean.
console.error = () => {};

/** Two disjoint viewport boxes at the same grid level. */
const BOUNDS_A: Bounds = { minLat: 49.2, maxLat: 49.3, minLng: -123.2, maxLng: -123.1 };
const BOUNDS_B: Bounds = { minLat: 43.6, maxLat: 43.7, minLng: -79.5, maxLng: -79.4 };

function cellsOf(bounds: Bounds): [number, number][] {
	return cellsForBounds(bounds, levelCell(levelForBounds(bounds)));
}

/** An empty-but-valid response covering exactly the requested cells. */
function emptyResponse(cells: [number, number][]): MapCellsData {
	return {
		locations: [],
		menus: {},
		menuMeta: {},
		cells: Object.fromEntries(cells.map(([i, j]) => [cellKey(i, j), []]))
	};
}

type FetchArgs = { level: number; cells: [number, number][]; q: string; diet: string | null };

/** A controllable getMapCells mock: every call is recorded and hand-settled. */
function mockFetch() {
	const calls: {
		args: FetchArgs;
		resolve: (data: MapCellsData) => void;
		reject: (err: unknown) => void;
	}[] = [];
	const fetch = (args: FetchArgs) =>
		new Promise<MapCellsData>((resolve, reject) => {
			calls.push({ args, resolve, reject });
		});
	return { calls, fetch };
}

/** Lets the settled promise's .then/.catch chain run. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ViewportData.sync', () => {
	test('fetches the missing cells once and replays banked cells locally', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		expect(vd.data).toBe(EMPTY_MAP_DATA);

		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(1);
		expect(calls[0].args.level).toBe(levelForBounds(BOUNDS_A));
		expect(calls[0].args.cells).toEqual(cellsOf(BOUNDS_A));
		expect(calls[0].args.q).toBe('');
		expect(calls[0].args.diet).toBeNull();

		calls[0].resolve(emptyResponse(calls[0].args.cells));
		await flush();
		// The bump re-runs the calling effect; the tests stand in for it.
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(1); // banked — no refetch
		expect(vd.data.locations).toEqual([]);
		expect(vd.fetchFailed).toBe(false);
		expect(vd.searching).toBe(false);
	});

	test('a null viewport is a no-op', () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.sync(null);
		expect(calls.length).toBe(0);
	});

	test('in-flight cells are waited on, not re-requested', () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.sync(BOUNDS_A);
		vd.sync(BOUNDS_A); // overlapping run mid-gesture
		expect(calls.length).toBe(1);
	});

	test('a browse failure in browse mode flags "browse" and keeps the previous data', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.sync(BOUNDS_A);
		const before = vd.data;
		calls[0].reject(new Error('boom'));
		await flush();
		expect(vd.fetchFailed).toBe('browse');
		expect(vd.searching).toBe(false);
		expect(vd.data).toBe(before); // never blanked
		// The failed cells left the in-flight set with no version bump: the next
		// run (viewport change) asks for them again.
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(2);
	});

	test('a search failure in search mode flags "search"', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.appliedFilter = { q: 'burger', diet: null };
		vd.sync(BOUNDS_A);
		expect(calls[0].args.q).toBe('burger');
		expect(vd.searching).toBe(true);
		calls[0].reject(new Error('boom'));
		await flush();
		expect(vd.fetchFailed).toBe('search');
		expect(vd.searching).toBe(false);
	});

	test('filter-change supersession: a stale browse failure mid-search stays silent', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		// Browse fetch goes out…
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(1);
		// …then the user commits a search before it lands: same cells, but the
		// store keys carry the filter, so this is a second, filtered fetch.
		vd.appliedFilter = { q: 'burger', diet: null };
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(2);
		expect(vd.searching).toBe(true);
		// The abandoned browse fetch fails: relevant on NEITHER count (mode is now
		// filtered, its unprefixed keys left the visible key set) — no flag, and
		// the live search keeps its spinner.
		calls[0].reject(new Error('boom'));
		await flush();
		expect(vd.fetchFailed).toBe(false);
		expect(vd.searching).toBe(true);
		// The live search failing IS flagged, worded for the search.
		calls[1].reject(new Error('boom'));
		await flush();
		expect(vd.fetchFailed).toBe('search');
		expect(vd.searching).toBe(false);
	});

	test('a superseded run whose cells are still pending gets its failure surfaced', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.sync(BOUNDS_A);
		// A successor run sees the same cells as pending and waits on the very
		// same fetch — its failure must not leave that run a silent hole.
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(1);
		calls[0].reject(new Error('boom'));
		await flush();
		expect(vd.fetchFailed).toBe('browse');
	});

	test('the spinner clears only once NO filtered fetch remains in flight', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.appliedFilter = { q: 'burger', diet: null };
		vd.sync(BOUNDS_A);
		vd.sync(BOUNDS_B); // second area, same search — two filtered fetches on the wire
		expect(calls.length).toBe(2);
		expect(vd.searching).toBe(true);
		calls[0].reject(new Error('boom'));
		await flush();
		// One filtered fetch still in flight: the spinner stays up.
		expect(vd.searching).toBe(true);
		expect(vd.fetchFailed).toBe('search');
		calls[1].resolve(emptyResponse(calls[1].args.cells));
		await flush();
		// The landing bump re-runs the effect against the current viewport: all of
		// B is now local, so the run settles the status flags.
		vd.sync(BOUNDS_B);
		expect(vd.searching).toBe(false);
		expect(vd.fetchFailed).toBe(false);
	});

	test('filtered and browse cells coexist: clearing the search replays warm browse cells', async () => {
		const { calls, fetch } = mockFetch();
		const vd = new ViewportData(fetch);
		vd.sync(BOUNDS_A);
		calls[0].resolve(emptyResponse(calls[0].args.cells));
		await flush();
		vd.appliedFilter = { q: 'burger', diet: null };
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(2); // the filter's own cells
		calls[1].resolve(emptyResponse(calls[1].args.cells));
		await flush();
		vd.appliedFilter = { q: '', diet: null };
		vd.sync(BOUNDS_A);
		expect(calls.length).toBe(2); // browse cells replay — no round trip
		expect(vd.searching).toBe(false);
	});
});

describe('ViewportData.scheduleCommit', () => {
	test('an empty filter commits synchronously and disarms the one-shot bypass', () => {
		const vd = new ViewportData(mockFetch().fetch);
		vd.appliedFilter = { q: 'stale', diet: 'vegan' };
		vd.searchImmediate = true;
		const cleanup = vd.scheduleCommit('', null);
		expect(cleanup).toBeUndefined();
		expect(vd.appliedFilter).toEqual({ q: '', diet: null });
		expect(vd.searchImmediate).toBe(false);
		expect(vd.flushSearch).toBeNull();
	});

	test('typed text commits only after the debounce, folded like the server', async () => {
		const vd = new ViewportData(mockFetch().fetch);
		vd.scheduleCommit('BURGER', null);
		expect(vd.appliedFilter).toEqual({ q: '', diet: null });
		await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));
		expect(vd.appliedFilter).toEqual({ q: 'burger', diet: null });
		expect(vd.flushSearch).toBeNull(); // consumed by the commit
	});

	test('a discrete input (searchImmediate) bypasses the debounce', async () => {
		const vd = new ViewportData(mockFetch().fetch);
		vd.searchImmediate = true;
		vd.scheduleCommit('burger', 'vegan');
		expect(vd.searchImmediate).toBe(false); // one-shot
		await flush();
		expect(vd.appliedFilter).toEqual({ q: 'burger', diet: 'vegan' });
	});

	test('flushSearch (Enter) fires the pending debounce at once', () => {
		const vd = new ViewportData(mockFetch().fetch);
		vd.scheduleCommit('burger', null);
		expect(vd.flushSearch).not.toBeNull();
		vd.flushSearch?.();
		expect(vd.appliedFilter).toEqual({ q: 'burger', diet: null });
		expect(vd.flushSearch).toBeNull(); // a stray Enter is now a no-op
	});

	test('the cleanup cancels a pending commit (mid-debounce edit)', async () => {
		const vd = new ViewportData(mockFetch().fetch);
		const cleanup = vd.scheduleCommit('burger', null);
		cleanup?.();
		expect(vd.flushSearch).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));
		expect(vd.appliedFilter).toEqual({ q: '', diet: null }); // never committed
	});
});
