// Shared category helpers for the map UI. Kept here (not in `$lib/server/db`,
// which is server-only) so client components can label categories without
// pulling server code into the browser bundle.

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

/** Human-readable label for a category; `''` for an unset (null) category. */
export function categoryLabel(category: Category | null): string {
	if (!category) return '';
	if (category === 'fast_food') return 'Fast food';
	return category.charAt(0).toUpperCase() + category.slice(1);
}
