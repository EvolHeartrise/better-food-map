// The landing-overlay coverage totals, factored out of data.remote.ts so the
// `getStats` remote function AND the GET /api/v1/stats endpoint share ONE
// implementation — and, crucially, ONE cache instance. The 5-minute memo lives
// at module scope here, so both consumers hit the same warmed copy instead of
// each keeping its own (which would double the COUNT-scan traffic).
import { requestSafeTtlMemo } from './request-memo';
import { requireDb } from './context';
import { getStats as getStatsFromDb, type MapStats } from './db';

/**
 * Coverage totals (locations, items, cities, per-diet dish counts) for the
 * zoomed-out landing overlay, memoised for 5 minutes: the query behind it is
 * three full-table COUNT scans per landing visitor, yet the totals only move when
 * data is ingested, so minutes of staleness is invisible. Per-isolate module
 * scope (each isolate warms its own copy, eviction resets it) is fine — the worst
 * case is one extra scan per isolate per window. `requireDb()` reads the
 * request-scoped event, so it must resolve INSIDE the memoised fn — safe, because
 * a cache miss only ever happens while a request is being served. The landing
 * page reads this non-suspending, so `requestSafeTtlMemo` guards the
 * never-settling-promise hazard (see its doc comment).
 */
export const getCachedStats: () => Promise<MapStats> = requestSafeTtlMemo(5 * 60 * 1000, () =>
	getStatsFromDb(requireDb())
);
