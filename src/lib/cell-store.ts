// The client-side cell cache behind the map's browse mode: one entry per
// fetched grid cell (keyed `level` + cell key — see $lib/grid), holding that
// cell's self-contained payload slice. Panning then only fetches the cells the
// viewport newly uncovered — the overlapping ones replay from here — and
// panning BACK is free (#84). Empty cells are stored too (an empty slice), so
// open ocean isn't re-asked for on every pass.
//
// Deliberately a plain non-reactive class: the store is a memo consulted inside
// the browse effect, never template state — mutating it must not re-run
// anything.

import type { CellSlice } from './map-cells';

/**
 * How long a cached cell serves before it's re-fetched. Data only changes via
 * MCP ingestion, so minutes of staleness is invisible while browsing; the cap
 * bounds how long a parked session can diverge from the map.
 */
export const CELL_TTL_MS = 5 * 60 * 1000;

/**
 * Entry cap. Cells are small (a rep cell holds ONE venue; a full cell a
 * neighbourhood's worth), so this bounds a long panning session to a few MB
 * while comfortably holding several viewports' worth per level.
 */
export const CELL_STORE_MAX = 512;

export class CellStore {
	// Insertion order doubles as recency order (Map preserves it; get() re-inserts),
	// so eviction is "delete the first key" — a minimal LRU.
	#entries = new Map<string, { slice: CellSlice; expires: number }>();
	readonly #now: () => number;

	/** `now` is injectable so tests can drive TTL expiry without real timers. */
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** The cached slice for `key`, or null when absent or expired. */
	get(key: string): CellSlice | null {
		const entry = this.#entries.get(key);
		if (!entry) return null;
		if (this.#now() >= entry.expires) {
			this.#entries.delete(key);
			return null;
		}
		// Refresh recency: re-insert at the back of the eviction order.
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.slice;
	}

	set(key: string, slice: CellSlice): void {
		this.#entries.delete(key);
		this.#entries.set(key, { slice, expires: this.#now() + CELL_TTL_MS });
		while (this.#entries.size > CELL_STORE_MAX) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}
}
