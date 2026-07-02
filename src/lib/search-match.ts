/**
 * The CLIENT half of the search-membership mirror: which venues a text query
 * and/or dietary tag keep on the map, and which of their items to surface.
 *
 * `getSearchMapData` (src/lib/server/db.ts) implements the SERVER half over the
 * FTS5 mirrors, and the two must agree — the client re-filters the result set
 * while a search is in flight, so any drift shows as venues with empty teaser
 * lines or markers that vanish once the client re-filter runs. This lives in a
 * pure module (not inline in +page.svelte) so scripts/search-parity.test.ts can
 * run the same fixtures through both halves and assert identical membership.
 *
 * The mirror is intentionally not bit-exact in two documented ways:
 *   • the server searches a chain's SHARED menu without per-location overrides,
 *     while the client filters the resolved (override-applied) menu — an item
 *     made unavailable at one branch simply drops from that card;
 *   • browse mode (no text, no diet) keeps every candidate here, whereas the
 *     server returns nothing (the caller only searches when a filter is set).
 */

/** The item fields membership reads: its name, and the ids of its tags. */
export interface SearchableItem {
	item_name: string;
	tags: Array<{ id: string }>;
}

/** A candidate venue: its name plus its RESOLVED (override-applied) menu. */
export interface SearchableLocation {
	name: string;
	menu: SearchableItem[];
}

/**
 * Whether a venue's NAME matches the active text query. False when there's no
 * text term (a diet-only filter never matches via the name — it acts on items).
 * `queryTerm` must be pre-normalised (trimmed + lowercased); `searchResults`
 * does this for its callers.
 */
export function nameMatches(name: string, queryTerm: string): boolean {
	return queryTerm !== '' && name.toLowerCase().includes(queryTerm);
}

/**
 * The menu items to surface for a venue under the active search — the line its
 * map label rotates through. The combined query is an OR across the venue name
 * and its item names: when the name matches (or there's no text term) the text
 * dimension is satisfied by the WHOLE menu; otherwise only items whose name
 * contains the term. The dietary selector then narrows that set — it ALWAYS
 * applies. With nothing active this is the whole menu (browse).
 */
export function matchedItems<I extends SearchableItem>(
	loc: { name: string; menu: I[] },
	queryTerm: string,
	diet: string | null
): I[] {
	const textItems =
		queryTerm === '' || nameMatches(loc.name, queryTerm)
			? loc.menu
			: loc.menu.filter((menuItem) => menuItem.item_name.toLowerCase().includes(queryTerm));
	return diet === null
		? textItems
		: textItems.filter((menuItem) => menuItem.tags.some((tag) => tag.id === diet));
}

/**
 * One entry per location to keep, paired with the items to tease under its
 * marker. With no query active every candidate is kept (its whole menu teased).
 * Under a search a venue is kept when its NAME matches (show all its items) or
 * at least one item matches; a name match with an active diet still requires a
 * diet-matching item (diet always narrows) — that falls out of `matchedItems`
 * being empty. `query` is normalised (trimmed + lowercased) here, so callers
 * may pass either the raw input or an already-normalised term.
 */
export function searchResults<I extends SearchableItem, L extends { name: string; menu: I[] }>(
	locations: L[],
	query: string,
	diet: string | null
): Array<{ loc: L; items: I[] }> {
	const queryTerm = query.trim().toLowerCase();
	const hasQuery = queryTerm !== '' || diet !== null;
	const out: Array<{ loc: L; items: I[] }> = [];
	for (const loc of locations) {
		const items = matchedItems(loc, queryTerm, diet);
		const keep =
			!hasQuery || (nameMatches(loc.name, queryTerm) && diet === null) || items.length > 0;
		if (keep) out.push({ loc, items });
	}
	return out;
}
