// ---------------------------------------------------------------------------
// Shared paging primitives for the read/audit tools (audit_locations finders,
// list_locations, search_overture_leads).
//
// Two things were copy-pasted across every finder: the requested-limit clamp
// (`Math.min(Math.max(min, trunc(limit ?? def)), max)`) and the result tail
// (`{ total, returned, additional, suppressed_dismissed }`). They are collected
// here so a call site declares only WHAT differs (its floor, whether it caps at
// MAX, whether it truncates fractional input) rather than re-spelling the whole
// expression — the existing per-finder inconsistencies (empty_menu floors at 0,
// duplicate_locations applies no MAX cap) are preserved by passing them, not by
// "fixing" them.
// ---------------------------------------------------------------------------

/** Default page size when the caller passes no `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Hard cap on a single page (search_poi / audit_locations / list_locations). */
export const MAX_PAGE_LIMIT = 200;

/**
 * Clamps a requested `limit` to `[min, max]`, defaulting to `def` when absent.
 * Each bound is applied only when supplied, so a call site opts into exactly the
 * clamping it wants:
 *   • `min` omitted  → no floor (matches a bare `limit ?? def`);
 *   • `max` omitted  → no ceiling (duplicate_locations imposes none);
 *   • `trunc` (default true) → `Math.trunc` fractional input first; pass false to
 *     preserve a call site that never truncated.
 * A too-large request is clamped (never rejected) so an over-eager caller still
 * gets a valid page.
 */
export function clampLimit(
	limit: number | undefined,
	opts: { def: number; min?: number; max?: number; trunc?: boolean }
): number {
	let n = limit ?? opts.def;
	if (opts.trunc ?? true) n = Math.trunc(n);
	if (opts.min !== undefined) n = Math.max(opts.min, n);
	if (opts.max !== undefined) n = Math.min(n, opts.max);
	return n;
}

/** The result tail every single-list audit finder shares. */
export interface PageTail {
	/** Full flagged count before `limit`/`offset`. */
	total: number;
	/** How many flagged rows this page carries (`page.length`). */
	returned: number;
	/** Flagged rows NOT returned because of `limit`/`offset` (clamped at 0). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
}

/**
 * Slices `flagged` into one page and computes the shared `{ total, returned,
 * additional, suppressed_dismissed }` tail. `offset` defaults to 0 (the finders
 * that don't page); `additional` is floored at 0 so a stale offset past the end
 * never reads as a negative remainder. `suppressed` is the DismissFilter's count.
 */
export function pageFindings<T>(
	flagged: readonly T[],
	opts: { limit: number; offset?: number; suppressed: number }
): { page: T[]; tail: PageTail } {
	const offset = opts.offset ?? 0;
	const page = flagged.slice(offset, offset + opts.limit);
	return {
		page,
		tail: {
			total: flagged.length,
			returned: page.length,
			additional: Math.max(0, flagged.length - offset - page.length),
			suppressed_dismissed: opts.suppressed
		}
	};
}
