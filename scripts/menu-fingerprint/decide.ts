// Pure comparison logic for the menu-source change gate: given a menu's
// baselined watch rows and the fresh fetch results, decide whether the menu
// can safely skip its agent refresh. Kept IO-free so the decision table is
// unit-testable without a network or a database.
//
// The design bias is STRICT — every ambiguous case routes to the agent path
// ("needs_refresh"), so the gate can only ever save work, never silently skip
// a real change:
//   • no fingerprints at all → agent path (a never-baselined menu is today's
//     behavior).
//   • a row whose baseline never produced a trustworthy hash (blocked or
//     degenerate at baseline time) → agent path. Excluding such rows from the
//     decision could stamp "unchanged" off a minor PDF while the bot-walled
//     MAIN menu page changed underneath. Curate the watch set (baseline.ts
//     --urls) to rescue those menus.
//   • a fetch that fails or degenerates NOW → agent path; a dead source is
//     exactly the dead_source/closure signal surfacing for free.
//   • any hash mismatch → agent path.
// Only a full sweep of stable, trustworthy rows yields "unchanged".

export type WatchKind = 'feed' | 'pdf' | 'html' | 'rendered';
export type FetchStatus = 'ok' | 'http_error' | 'blocked' | 'degenerate';

export interface WatchRow {
	url: string;
	kind: WatchKind;
	content_hash: string | null;
	signal_hash: string | null;
	etag: string | null;
	last_modified: string | null;
	fetch_status: FetchStatus;
}

export interface FetchOutcome {
	url: string;
	fetch_status: FetchStatus;
	/** Conditional GET answered 304 — content unchanged by definition. */
	not_modified?: boolean;
	content_hash: string | null;
	signal_hash: string | null;
	etag: string | null;
	last_modified: string | null;
}

export type RowVerdict = 'stable' | 'changed' | 'unfetchable' | 'no_baseline';

export function compareRow(prior: WatchRow, result: FetchOutcome): RowVerdict {
	if (prior.fetch_status !== 'ok' || prior.content_hash === null) return 'no_baseline';
	if (result.not_modified) return 'stable';
	if (result.fetch_status !== 'ok' || result.content_hash === null) return 'unfetchable';
	// html/rendered: prefer the price-line signal when BOTH sides have one —
	// full visible text churns with banners/hours/review counts while the price
	// multiset does not. A side losing its signal (page redesign dropped below
	// MIN_PRICE_LINES) falls through to the strict content comparison.
	if (
		(prior.kind === 'html' || prior.kind === 'rendered') &&
		prior.signal_hash !== null &&
		result.signal_hash !== null
	) {
		return prior.signal_hash === result.signal_hash ? 'stable' : 'changed';
	}
	return prior.content_hash === result.content_hash ? 'stable' : 'changed';
}

export interface MenuDecision {
	verdict: 'unchanged' | 'needs_refresh';
	/** Machine-readable reason, first blocker wins; absent when unchanged. */
	reason?: string;
	/** Urls behind the reason (changed/failed/baseline-less rows). */
	urls?: string[];
}

export function decideMenu(rows: WatchRow[], results: Map<string, FetchOutcome>): MenuDecision {
	if (rows.length === 0) return { verdict: 'needs_refresh', reason: 'no_fingerprints' };
	const noBaseline: string[] = [];
	const unfetchable: string[] = [];
	const changed: string[] = [];
	for (const row of rows) {
		const result = results.get(row.url);
		if (!result) {
			unfetchable.push(row.url);
			continue;
		}
		const verdict = compareRow(row, result);
		if (verdict === 'no_baseline') noBaseline.push(row.url);
		else if (verdict === 'unfetchable') unfetchable.push(row.url);
		else if (verdict === 'changed') changed.push(row.url);
	}
	if (changed.length > 0) return { verdict: 'needs_refresh', reason: 'changed', urls: changed };
	if (unfetchable.length > 0)
		return { verdict: 'needs_refresh', reason: 'fetch_failed', urls: unfetchable };
	if (noBaseline.length > 0)
		return { verdict: 'needs_refresh', reason: 'no_baseline_hash', urls: noBaseline };
	return { verdict: 'unchanged' };
}
