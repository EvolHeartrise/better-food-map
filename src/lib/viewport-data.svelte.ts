// The map page's viewport-data orchestration, extracted from
// src/routes/+page.svelte: the client cell store, the in-flight bookkeeping,
// the debounced filter commit and the searching/fetchFailed status flags, as
// one class the page consumes. Runes in a `.svelte.ts` module — the `$state`
// fields below drive the page's deriveds/template exactly like the page-local
// state they replaced. The class owns no effects of its own: the page runs two
// thin `$effect`s that call {@link ViewportData.scheduleCommit} and
// {@link ViewportData.sync}, so every reactive read in those methods registers
// with the calling effect — and the logic is unit-testable without a DOM
// (scripts/viewport-data.test.ts) by calling the same methods directly.

import { CellStore } from '$lib/cell-store';
import { cellKey, cellsForBounds, levelCell, levelForBounds } from '$lib/grid';
import { mergeCellSlices, splitCellSlices, type CellSlice } from '$lib/map-cells';
import { foldAsciiCase } from '$lib/search';
import type { Bounds, MapCellsData, MapData } from '$lib/server/db';

export const EMPTY_MAP_DATA: MapData = { locations: [], menus: {}, menuMeta: {} };

// Debounce before a query change commits (and so hits the server), so a burst
// of keystrokes settles into one fetch. Applied to TYPED changes only —
// discrete inputs (a diet click, Enter, paste) are single deliberate actions
// with no burst to coalesce, so waiting the full debounce there is pure lag.
// Two bypass channels, both plain non-reactive plumbing:
// `searchImmediate` is a one-shot flag consumed by the commit effect's next
// run, for inputs whose change re-runs the effect (diet click, paste);
// `flushSearch` fires a pending debounce timer at once, for Enter — the
// signature hasn't changed then, so the effect won't re-run. Null whenever no
// timer is pending (already fired, or flushed), making a stray Enter a no-op.
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The one server read this module drives: the per-cell viewport fetch
 * (getMapCells, $lib/data.remote). Injected so the module never imports the
 * remote-function machinery — the page passes the real query, tests a mock.
 */
export type FetchMapCells = (args: {
	level: number;
	cells: [number, number][];
	q: string;
	diet: string | null;
}) => Promise<MapCellsData>;

export class ViewportData {
	// --- Map data --------------------------------------------------------------
	// The one rendered payload: what's in the current box under the current
	// APPLIED filter (see appliedFilter below). Updated imperatively (rather than
	// via an awaited $derived) so the markers already on screen stay put while
	// the next set loads — the map never blanks, and a filter change keeps the
	// previous markers (re-narrowed locally by the page's `results`) until the
	// filtered cells land.
	data = $state<MapData>(EMPTY_MAP_DATA);

	// --- Fetch status ----------------------------------------------------------
	// The cell fetch below keeps the previous markers on screen while a request is
	// in flight or after it fails — right for the map, but invisible to the user.
	// `searching` is true while a FILTERED fetch is in flight and drives a spinner
	// in the search pill; `fetchFailed` feeds the floating status line (plus its
	// always-mounted aria-live twin) so a failed fetch says so instead of silently
	// showing old data. It records WHICH KIND of fetch failed — the wording must
	// describe the request that actually broke, not whatever the query box holds
	// by the time the line renders (typing a character mustn't relabel a browse
	// failure as a search failure). Imperative flags rather than
	// $effect.pending(): these are .then() chains, not awaits a boundary could
	// count.
	searching = $state(false);
	fetchFailed = $state<false | 'browse' | 'search'>(false);

	// --- Applied filter (the debounced commit) ----------------------------------
	// The filter the cell fetch below actually sends: the gated text + diet as of
	// the last COMMIT. Typing edits the live query (and the page's local `results`
	// narrowing tracks every keystroke instantly), but the server round trips
	// only happen against this committed copy, so a keystroke burst settles into
	// one fetch. Discrete inputs bypass the wait — see SEARCH_DEBOUNCE_MS.
	appliedFilter = $state<{ q: string; diet: string | null }>({ q: '', diet: null });

	// The debounce-bypass channels (see SEARCH_DEBOUNCE_MS above). Plain
	// non-reactive plumbing, deliberately.
	searchImmediate = false;
	flushSearch: (() => void) | null = null;

	// Load the visible box, one GRID CELL at a time, under the APPLIED filter
	// (see sync()). The store is a plain non-reactive memo (filter+level-prefixed
	// cell key → payload slice, LRU + TTL): consulting or filling it must never
	// re-run the effect that calls sync().
	readonly #cellStore = new CellStore();
	// Store keys with a fetch currently on the wire. The viewport streams in
	// THROTTLED reports while a gesture is still moving (see LocationMap), so
	// consecutive sync() runs overlap in time and would otherwise re-request the
	// same not-yet-banked cells; a run treats an in-flight cell as neither hit
	// nor missing and simply waits for it. Non-reactive on purpose, like the
	// store — a memo mutated inside the effect; reactivity would re-run the
	// effect it serves.
	readonly #inflightCells = new Set<string>();
	// How many FILTERED fetches are on the wire right now. The spinner must stay
	// up while ANY search fetch is still in flight — a stale BROWSE fetch failing
	// mid-search must not kill it — so completions consult this count instead of
	// clobbering `searching` unconditionally. Non-reactive, like the sets above.
	#filteredFetchesInFlight = 0;
	// Snapshot of the LATEST sync() run's store keys and mode, so a late failure
	// can tell whether it still describes what's on screen: a failing fetch sets
	// `fetchFailed` only if its kind matches the current mode (the accepted brief
	// over-warn on plain viewport moves) or its cells are still in the current
	// key set (a successor run may be waiting on that very fetch — see the catch).
	// A stale fetch relevant on NEITHER count (e.g. a browse fetch failing after
	// the user started a search) stays silent rather than mislabeling the status.
	#visibleCellKeys = new Set<string>();
	#currentModeFiltered = false;
	// Bumped when a fetch banks its cells, so the calling effect re-runs sync()
	// against the CURRENT viewport and re-merges from the store. This replaces
	// the old per-run "merge my own response" callback: with overlapping runs,
	// the run that issued a fetch is routinely superseded before its response
	// lands, and the bump is what surfaces those banked cells regardless.
	#storeVersion = $state(0);

	readonly #fetchCells: FetchMapCells;

	constructor(fetchCells: FetchMapCells) {
		this.#fetchCells = fetchCells;
	}

	/**
	 * Commits the live query into `appliedFilter`: after the typing debounce, at
	 * once for a discrete input, and at once when the filter empties — clearing
	 * must drop back to unfiltered data without a lag the user would read as a
	 * stuck search. The committed text is the FOLDED form — semantically
	 * identical to the raw text on the server (LIKE folds ASCII itself), and it
	 * canonicalizes the wire arg so ASCII case variants share one colo cache
	 * entry. Called from a page `$effect` keyed on the query signature; returns
	 * that effect's cleanup (cancel the pending timer, disarm Enter).
	 */
	scheduleCommit(searchText: string, diet: string | null): (() => void) | undefined {
		const commit = () => {
			this.flushSearch = null;
			this.appliedFilter = { q: foldAsciiCase(searchText), diet };
		};
		if (searchText === '' && diet === null) {
			this.searchImmediate = false;
			commit();
			return;
		}
		// A discrete input (diet click, paste) armed the one-shot bypass: fire on
		// the next tick instead of sitting out the typing debounce.
		const immediate = this.searchImmediate;
		this.searchImmediate = false;
		const timer = setTimeout(commit, immediate ? 0 : SEARCH_DEBOUNCE_MS);
		// Let Enter fire the pending debounce early (commit nulls this once run).
		this.flushSearch = () => {
			clearTimeout(timer);
			commit();
		};
		return () => {
			clearTimeout(timer);
			this.flushSearch = null;
		};
	}

	/**
	 * Loads the visible box, one GRID CELL at a time, under the APPLIED filter.
	 * The padded viewport picks a grid level and enumerates the cells covering it
	 * ($lib/grid); cells already in the client store replay locally, so panning
	 * fetches only the newly uncovered strip and panning back costs nothing (#84)
	 * — the 20% bounds padding is a genuine prefetch ring, not dead weight. With
	 * a filter active the SAME read narrows server-side to matching venues (a rep
	 * cell keeps its top-ranked MATCH, so a non-matching neighbour can't hide
	 * it), which is what makes panning under a search actually search the new
	 * area; store keys carry the filter, so browse cells and each filter's cells
	 * coexist without cross-talk and clearing the search replays warm browse
	 * cells with no round trip.
	 *
	 * Called from a page `$effect` that passes the live viewport; the reads of
	 * `#storeVersion` and `appliedFilter` here are what re-run that effect when
	 * a fetch banks its cells or the filter commits.
	 */
	sync(viewport: Bounds | null): void {
		void this.#storeVersion;
		if (!viewport) return;
		const bounds = viewport;
		const filter = this.appliedFilter;
		const filtered = filter.q !== '' || filter.diet !== null;
		const level = levelForBounds(bounds);
		const cells = cellsForBounds(bounds, levelCell(level));
		// `filter.q` is committed pre-folded (see scheduleCommit), so the key
		// equivalence-classes exactly the queries the server answers identically —
		// no wider. The unit-separator delimiters keep the (q, diet, level)
		// segments collision-free (free text could otherwise run into the diet id).
		const prefix = filtered ? `${filter.q}\u001f${filter.diet ?? ''}\u001f` : '';
		const storeKey = ([i, j]: [number, number]) => `${prefix}${level}/${cellKey(i, j)}`;
		// Refresh the relevance snapshot for late completions (see the declarations
		// above): this run is now the current view, in the current mode.
		this.#visibleCellKeys = new Set(cells.map(storeKey));
		this.#currentModeFiltered = filtered;
		const hits: CellSlice[] = [];
		const missing: [number, number][] = [];
		let pending = 0;
		for (const c of cells) {
			const slice = this.#cellStore.get(storeKey(c));
			if (slice !== null) hits.push(slice);
			else if (this.#inflightCells.has(storeKey(c))) pending++;
			else missing.push(c);
		}
		if (missing.length === 0 && pending === 0) {
			// Everything in view is already local — the "known empty" negative
			// entries included — so render without a round trip.
			this.data = mergeCellSlices(hits);
			this.fetchFailed = false;
			this.searching = false;
			return;
		}
		// The spinner tracks FILTERED fetches only: it lives in the search pill,
		// where it reads as "your search is still filling this area".
		this.searching = filtered;
		// In-flight cells cover the rest of the view: their landing bumps
		// #storeVersion, re-running the calling effect to merge them. Until then
		// the previous `data` stays up, so mid-gesture frames never blank.
		if (missing.length === 0) return;
		const missingKeys = missing.map(storeKey);
		for (const key of missingKeys) this.#inflightCells.add(key);
		if (filtered) this.#filteredFetchesInFlight++;
		this.#fetchCells({ level, cells: missing, q: filter.q, diet: filter.diet })
			.then((data) => {
				const fresh = splitCellSlices(data);
				for (const [key, slice] of fresh) {
					this.#cellStore.set(`${prefix}${level}/${key}`, slice);
				}
				for (const key of missingKeys) this.#inflightCells.delete(key);
				if (filtered) this.#filteredFetchesInFlight--;
				this.#storeVersion++;
			})
			// A failed fetch must not blank the map — keep the markers already on
			// screen — but flag it so the status line can say the visible markers
			// are stale, worded for the kind of fetch that actually broke. Its
			// cells leave the in-flight set with NO version bump: an automatic
			// retry could loop against a broken backend, so, exactly as before,
			// the next viewport change is what asks for them again.
			.catch((err) => {
				console.error('map cells fetch failed', bounds, filter, err);
				for (const key of missingKeys) this.#inflightCells.delete(key);
				if (filtered) this.#filteredFetchesInFlight--;
				// The spinner clears only once NO filtered fetch remains in flight:
				// a stale browse fetch failing mid-search must not kill the spinner
				// the live search still owns (the status invariants up top).
				if (this.#filteredFetchesInFlight === 0) this.searching = false;
				// Flag the failure only while it's still RELEVANT — its kind matches
				// the current mode (this keeps the accepted brief over-warn when the
				// viewport has merely moved off the cells), or its cells are still in
				// the current key set. The key-set arm matters even for a superseded
				// run: the in-flight dedup means the run that replaced this one did
				// NOT refetch these cells — it saw them as pending and is WAITING on
				// this very fetch, with no dependency left to change. Skipping the
				// flag there would leave that successor a silent hole (cells neither
				// rendered, retried, nor flagged) until the next pan/filter change.
				// A fetch relevant on neither count (mode changed AND cells gone from
				// view) stays silent: its wording would describe a request the user
				// has already abandoned, clobbering the live one's status.
				const relevant =
					filtered === this.#currentModeFiltered ||
					missingKeys.some((key) => this.#visibleCellKeys.has(key));
				if (relevant) this.fetchFailed = filtered ? 'search' : 'browse';
			});
	}
}
