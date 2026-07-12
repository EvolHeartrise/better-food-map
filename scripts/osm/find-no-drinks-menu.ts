// ---------------------------------------------------------------------------
// no_drinks_menu audit: OPEN sit-down restaurants whose effective menu carries
// items but not a single drink.
//
// A venue's menu must be EXHAUSTIVE, and the documented failure mode behind a
// non-exhaustive one is a MISSED MENU PAGE: sites routinely split the menu
// across pages/tabs (food / drinks / cocktails / brunch), and research that
// stops at the first "Menu" link ingests everything except the drinks list. A
// sit-down restaurant with a populated menu and zero drink-tagged items is the
// classic tell of that miss (e.g. MeeT on Main, 2026-07: 37 food/dessert items
// ingested, the site's separate Drink/Happy Hour/Brunch pages skipped).
//
// Scope is deliberately category = 'restaurant' only: cafes and fast-food
// menus without an itemized drink are unremarkable, and bakeries rarely list
// drinks at all — flagging them would drown the signal. Venues below
// `min_items` effective items are left to the empty_menu audit (a menu with no
// items has "no drinks" only vacuously). Effective count follows
// find-incomplete-menus: private or shared menu, minus this branch's
// overridden-unavailable items. Only REQUIRED drink links count — course tags
// can never be optional, so an optional link would be bad data, not a drink.
//
// A venue verified to genuinely serve no drinks (or whose source lists none)
// is dismissed like any other finding; the fingerprint pins the effective item
// count, so a menu that changes size re-surfaces for a fresh look.
//
// Reads only the live D1. Unit-tested in find-no-drinks-menu.test.ts against
// the real migration schema.
// ---------------------------------------------------------------------------

import { formatAddress } from '../../src/lib/address';
import type { D1Like } from '../../src/lib/server/db';
import { DismissFilter, type DismissableFinding, type DismissalOpts } from './audit-dismiss';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, clampLimit, pageFindings } from './paging';

/** One flagged restaurant on the missing-drinks work-list. */
export interface NoDrinksLocation extends DismissableFinding {
	id: string;
	name: string;
	/** Canonical single-line display address (derived, never stored). */
	address: string;
	/** Effective item count: menu items minus this branch's unavailable overrides. */
	item_count: number;
	brand_id: string | null;
	menu_id: string | null;
}

export interface FindNoDrinksMenusResult {
	locations: NoDrinksLocation[];
	/** Total open restaurants flagged (≥ min_items effective items, zero drinks), across the whole DB. */
	total: number;
	/** How many of those are in `locations` (≤ limit). */
	returned: number;
	/** Flagged locations NOT returned because of `limit` (total - returned). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
	/** The floor applied — only venues with at least this many effective items are considered. */
	min_items: number;
}

const DEFAULT_MIN_ITEMS = 1;

/** Raw grouped-query row (address parts kept only to derive the display address). */
interface NoDrinksRow {
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
 * Flags every OPEN `restaurant`-category location whose effective menu has at
 * least `min_items` items (default 1) but ZERO required drink-tagged ones.
 * Biggest menus first — the more items a drink-less menu carries, the more
 * certain a whole page was missed rather than the venue being drink-less.
 * `limit` (default 50, max 200) caps the returned list with the remainder
 * counted in `additional`; `total` is the full flagged count.
 *
 * One grouped query does all the counting, the same LEFT JOIN shape as
 * find-incomplete-menus plus a drink-link join; the drinkless filter lives in
 * the HAVING so no per-location follow-up reads are needed.
 */
export async function findNoDrinksMenus(
	db: D1Like,
	opts: { min_items?: number; limit?: number } & DismissalOpts = {}
): Promise<FindNoDrinksMenusResult> {
	const minItems = Math.max(1, Math.trunc(opts.min_items ?? DEFAULT_MIN_ITEMS));
	const limit = clampLimit(opts.limit, {
		def: DEFAULT_PAGE_LIMIT,
		min: 0,
		max: MAX_PAGE_LIMIT
	});
	const filter = new DismissFilter(opts);

	const { results } = await db
		.prepare(
			`SELECT l.id AS id, l.name AS name, l.street AS street, l.city AS city,
			        l.region AS region, l.postcode AS postcode,
			        l.brand_id AS brand_id, l.menu_id AS menu_id,
			        COUNT(
			          CASE WHEN i.id IS NOT NULL AND (o.available IS NULL OR o.available <> 0)
			               THEN 1 END
			        ) AS item_count,
			        COUNT(
			          CASE WHEN d.tag_id IS NOT NULL AND (o.available IS NULL OR o.available <> 0)
			               THEN 1 END
			        ) AS drink_count
			 FROM locations l
			 LEFT JOIN items i ON i.menu_id = l.menu_id
			 LEFT JOIN location_item_overrides o
			   ON o.location_id = l.id AND o.item_id = i.id
			 LEFT JOIN item_tags d
			   ON d.item_id = i.id AND d.tag_id = 'drink' AND d.optional = 0
			 WHERE l.closed_at IS NULL AND l.category = 'restaurant'
			 GROUP BY l.id
			 HAVING item_count >= ? AND drink_count = 0
			 ORDER BY item_count DESC, l.name ASC`
		)
		.bind(minItems)
		.all<NoDrinksRow>();

	const flagged: NoDrinksLocation[] = [];
	for (const r of results) {
		// A dismissal says this venue genuinely serves no drinks; a changed menu
		// size is new evidence worth a fresh look.
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

	const { page: locations, tail } = pageFindings(flagged, {
		limit,
		suppressed: filter.suppressed
	});
	return { locations, ...tail, min_items: minItems };
}
