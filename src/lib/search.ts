// ---------------------------------------------------------------------------
// The shared client/server gate for the menu search's free-text term.
//
// The FTS5 trigram mirrors (migration 0016) can index-accelerate a `LIKE '%q%'`
// only when the pattern carries a run of 3+ literal characters. Anything below
// that — "b", "bu", or wildcard-broken text like "%" or "r_s" — falls back to a
// full scan of BOTH mirrors: an expensive query for a result the map page's
// own in-view filtering already covers (issues #103/#104). Both sides apply
// the SAME gate: the map page never sends unsearchable text with a cell fetch
// (it keeps filtering locally), and the server (getMapCells → searchMembership)
// treats such text as absent so a forged request can't force the scan either.
//
// Pure and client-safe (like $lib/text.ts) so the page and the server data
// layer share one definition of "searchable".
// ---------------------------------------------------------------------------

/** The FTS5 trigram width: the shortest literal run the index can serve. */
const SEARCH_MIN_RUN = 3;

/**
 * ASCII-only lowercase — the EXACT case folding SQLite's `LIKE` applies (it
 * folds A-Z alone; 'É' and 'é' stay distinct). Every client-side membership
 * comparison and every filter cache key must fold with THIS, never
 * `toLowerCase()`: JS lowercasing is Unicode-aware, so it would equate case
 * pairs the server distinguishes — the client filter would keep a venue the
 * filtered cell read dropped (a marker that vanishes when the fetch lands),
 * and two queries the server answers differently would collide on one cached
 * (possibly empty) cell entry.
 */
export function foldAsciiCase(text: string): string {
	return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The longest run of characters carrying no LIKE wildcard/escape (`%`, `_`,
 * `\`). Splitting on exactly those characters mirrors `escapeLikePattern`
 * (db.ts): each run survives escaping verbatim, so a run of
 * {@link SEARCH_MIN_RUN}+ characters is precisely what lets the trigram index
 * serve the pattern (and pre-filter the LIKE+ESCAPE form — see
 * searchMembership, db.ts).
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
