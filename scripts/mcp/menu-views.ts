// ---------------------------------------------------------------------------
// Per-`view` menu projections shared by get_menu and get_location. Split out of
// the large db-mcp-server.ts into a focused, directly unit-testable module.
//
// The three views trade payload size for detail:
//   • "full"    — every item in full detail (the caller strips the menu-level
//                 currency/menu_id separately via itemWithinParent);
//   • "names"   — id / item_name / price / tag-ids only (menu-wide scans and
//                 dietary-tag audits without the prose);
//   • "summary" — no item list at all, just counts and a per-tag histogram.
// get_menu DEFAULTS to "names" (a shared chain menu can be hundreds of items);
// get_location DEFAULTS to "full" (a single venue's menu is typically small).
// ---------------------------------------------------------------------------

import type { Item } from '../../src/lib/server/db';

/** The selectable payload size for a menu/location read. */
export type MenuView = 'full' | 'names' | 'summary';

/** One item in the lean "names" projection: id / name / price / tag-ids. */
export interface ItemNameView {
	id: string;
	item_name: string;
	price: number | null;
	/** Tag ids, an optional tag suffixed " (optional)" so the flag survives the projection. */
	tags: string[];
}

/** Counts + per-tag histogram for the "summary" view (no item list). */
export interface MenuItemsSummary {
	item_count: number;
	items_with_price: number;
	tag_counts: Record<string, number>;
}

/** Projects one item to the lean "names" shape (id / item_name / price / tag-ids). */
export function itemNameView(item: Item): ItemNameView {
	return {
		id: item.id,
		item_name: item.item_name,
		price: item.price,
		tags: item.tags.map((t) => (t.optional ? `${t.id} (optional)` : t.id))
	};
}

/**
 * Summarizes a menu's items for the "summary" view: total count, how many carry a
 * price, and a per-tag-id histogram (optional and required tags counted alike,
 * since every tag on the item is counted). Provenance is menu-level, so a source
 * count is not an item-level statistic — read the menu's own `sources`.
 */
export function menuItemsSummary(items: Item[]): MenuItemsSummary {
	const tagCounts: Record<string, number> = {};
	let priced = 0;
	for (const item of items) {
		if (item.price !== null) priced++;
		for (const tag of item.tags) tagCounts[tag.id] = (tagCounts[tag.id] ?? 0) + 1;
	}
	return {
		item_count: items.length,
		items_with_price: priced,
		tag_counts: tagCounts
	};
}
