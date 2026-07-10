// ---------------------------------------------------------------------------
// empty_menu audit: OPEN map locations whose EFFECTIVE menu is empty (or, with a
// higher `min_items`, suspiciously thin).
//
// The data policy is that a venue's menu must be EXHAUSTIVE — never a
// representative sample — but nothing surfaced venues that ended up with zero
// items (a create_locations that never got its create_items follow-up, an
// import_chain onto a menu whose items were later deleted, a branch whose only
// items are all overridden-unavailable). This audit is that detector: it counts
// each open location's effective items and flags the ones below `min_items`
// (default 1 ⇒ only truly-empty menus).
//
// "Effective item count" accounts for the two menu models with one grouped
// query — the same shape the location tag-overview uses (getLocationsWithTags):
//   • an INDEPENDENT venue counts the items on its own private menu;
//   • a CHAIN BRANCH counts the items on its shared menu MINUS the ones this
//     branch has overridden to available = false (location_item_overrides);
//   • a location with menu_id = null, or a menu with no items, counts as 0.
// Closed (soft-deleted, migration 0015) locations are excluded — they are hidden
// from the map anyway.
//
// Reads only the live D1 (no OSM store), like find-duplicate-locations. Unit-
// tested in find-incomplete-menus.test.ts against the real migration schema.
// ---------------------------------------------------------------------------

import { formatAddress } from '../../src/lib/address';
import type { D1Like } from '../../src/lib/server/db';
import { DismissFilter, type DismissableFinding, type DismissalOpts } from './audit-dismiss';

/** One flagged location on the empty/thin-menu work-list. */
export interface IncompleteMenuLocation extends DismissableFinding {
	id: string;
	name: string;
	/** Canonical single-line display address (derived, never stored). */
	address: string;
	/** Effective item count: menu items minus this branch's unavailable overrides. */
	item_count: number;
	brand_id: string | null;
	menu_id: string | null;
}

export interface FindIncompleteMenusResult {
	locations: IncompleteMenuLocation[];
	/** Total open locations flagged (effective count < min_items), across the whole DB. */
	total: number;
	/** How many of those are in `locations` (≤ limit). */
	returned: number;
	/** Flagged locations NOT returned because of `limit` (total - returned). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
	/** The threshold applied — a location is flagged when its effective count is below this. */
	min_items: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MIN_ITEMS = 1;

/** Raw grouped-query row (address parts kept only to derive the display address). */
interface IncompleteRow {
	id: string;
	name: string;
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	brand_id: string | null;
	menu_id: string | null;
	item_count: number;
}

/**
 * Flags every OPEN location whose EFFECTIVE item count is `< min_items`
 * (default 1 ⇒ only empty menus). Worst-first: 0-item menus lead, then ascending
 * count, then name. `limit` (default 50, max 200) caps the returned list with the
 * remainder counted in `additional`; `total` is the full flagged count.
 *
 * One grouped query does all the counting — a LEFT JOIN over items (matched by
 * the location's menu_id, so both the private-menu and shared-menu models are
 * covered) and location_item_overrides, counting an item only when it exists and
 * is not overridden unavailable at this branch. No N+1 per-location reads.
 */
export async function findIncompleteMenus(
	db: D1Like,
	opts: { min_items?: number; limit?: number } & DismissalOpts = {}
): Promise<FindIncompleteMenusResult> {
	const minItems = Math.max(0, Math.trunc(opts.min_items ?? DEFAULT_MIN_ITEMS));
	const limit = Math.min(Math.max(0, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	const filter = new DismissFilter(opts);

	const { results } = await db
		.prepare(
			`SELECT l.id AS id, l.name AS name, l.street AS street, l.city AS city,
			        l.region AS region, l.postcode AS postcode,
			        l.brand_id AS brand_id, l.menu_id AS menu_id,
			        COUNT(
			          CASE WHEN i.id IS NOT NULL AND (o.available IS NULL OR o.available <> 0)
			               THEN 1 END
			        ) AS item_count
			 FROM locations l
			 LEFT JOIN items i ON i.menu_id = l.menu_id
			 LEFT JOIN location_item_overrides o
			   ON o.location_id = l.id AND o.item_id = i.id
			 WHERE l.closed_at IS NULL
			 GROUP BY l.id
			 HAVING item_count < ?
			 ORDER BY item_count ASC, l.name ASC`
		)
		.bind(minItems)
		.all<IncompleteRow>();

	const flagged: IncompleteMenuLocation[] = [];
	for (const r of results) {
		// A dismissal says this venue's menu is legitimately this size (e.g. the
		// source genuinely lists nothing); a changed count is new evidence.
		const decision = filter.evaluate(r.id, String(r.item_count));
		if (decision.drop) continue;
		flagged.push({
			id: r.id,
			name: r.name,
			address: formatAddress({
				street: r.street,
				city: r.city,
				region: r.region,
				postcode: r.postcode
			}),
			item_count: r.item_count,
			brand_id: r.brand_id,
			menu_id: r.menu_id,
			...decision.fields
		});
	}

	const locations = flagged.slice(0, limit);
	return {
		locations,
		total: flagged.length,
		returned: locations.length,
		additional: flagged.length - locations.length,
		suppressed_dismissed: filter.suppressed,
		min_items: minItems
	};
}
