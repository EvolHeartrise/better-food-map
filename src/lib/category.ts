// Shared category helpers for the map UI. Kept here (not in `$lib/server/db`,
// which is server-only) so client components can label categories without
// pulling server code into the browser bundle.

import { m } from '$lib/paraglide/messages';

/**
 * The canonical list of food-location categories. The `Category` type is derived
 * from it, and the MCP server's category picklist is built from it, so adding a
 * category here flows to both automatically.
 */
export const CATEGORIES = ['cafe', 'fast_food', 'restaurant', 'bakery'] as const;

/**
 * A food location's category. This is the canonical definition; `$lib/server/db`
 * re-exports it (so server code shares one source of truth) and the OSM pipeline's
 * `SuggestedCategory` aliases it. Kept in this client-safe module so the type can
 * be shared without pulling server code into the browser bundle.
 */
export type Category = (typeof CATEGORIES)[number];

// Localized label for each category, keyed by its stable (English) id. The id
// stays English everywhere in the data/API; only the shown label localizes,
// resolved through Paraglide's per-request locale.
const CATEGORY_LABELS: Record<Category, () => string> = {
	cafe: m.category_cafe,
	fast_food: m.category_fast_food,
	restaurant: m.category_restaurant,
	bakery: m.category_bakery
};

/** Human-readable, localized label for a category; `''` for an unset (null) category. */
export function categoryLabel(category: Category | null): string {
	return category ? CATEGORY_LABELS[category]() : '';
}
