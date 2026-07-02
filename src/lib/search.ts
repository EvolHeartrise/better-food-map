// ---------------------------------------------------------------------------
// The shared client/server gate for the global menu search's free-text term.
//
// The FTS5 trigram mirrors (migration 0016) can index-accelerate a `LIKE '%q%'`
// only when the pattern carries a run of 3+ literal characters. Anything below
// that — "b", "bu", or wildcard-broken text like "%" or "r_s" — falls back to a
// full scan of BOTH mirrors plus a near-global distance sort: the most
// expensive query in the app, for a result the map page's own in-view
// filtering already covers (issues #103/#104). Both sides apply the SAME gate:
// the map page skips the server call for unsearchable text (and keeps
// filtering locally), and getSearchMapData treats such text as absent so a
// forged request can't force the scan either.
//
// Pure and client-safe (like $lib/text.ts) so the page and the server data
// layer share one definition of "searchable".
// ---------------------------------------------------------------------------

/** The FTS5 trigram width: the shortest literal run the index can serve. */
export const SEARCH_MIN_RUN = 3;

/**
 * The longest run of characters carrying no LIKE wildcard/escape (`%`, `_`,
 * `\`). Splitting on exactly those characters mirrors `escapeLikePattern`
 * (db.ts): each run survives escaping verbatim, so a run of
 * {@link SEARCH_MIN_RUN}+ characters is precisely what lets the trigram index
 * serve the pattern (and pre-filter the LIKE+ESCAPE form — see
 * getSearchMapData).
 */
export function longestLiteralRun(text: string): string {
	let longest = '';
	for (const run of text.split(/[\\%_]/)) {
		if (run.length > longest.length) longest = run;
	}
	return longest;
}

/**
 * The trimmed query when the trigram index can accelerate it, else `''` — "no
 * text dimension". Callers treat the empty result as text-free: the client
 * doesn't send it (its local filtering handles short prefixes instantly) and
 * the server ignores it (a diet-only search still runs; with no diet either,
 * the existing empty-query guard returns the empty result set).
 */
export function searchableQuery(query: string): string {
	const text = query.trim();
	return longestLiteralRun(text).length >= SEARCH_MIN_RUN ? text : '';
}
