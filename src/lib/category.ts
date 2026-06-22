// Shared category helpers for the map UI. Kept here (not in `$lib/server/db`,
// which is server-only) so client components can label categories without
// pulling server code into the browser bundle.

/**
 * A food location's category. This is the canonical definition; `$lib/server/db`
 * re-exports it (so server code shares one source of truth) and the OSM pipeline's
 * `SuggestedCategory` aliases it. Kept in this client-safe module so the type can
 * be shared without pulling server code into the browser bundle.
 */
export type Category = 'cafe' | 'fast_food' | 'restaurant' | 'bakery';

/** Human-readable label for a category; `''` for an unset (null) category. */
export function categoryLabel(category: Category | null): string {
	if (!category) return '';
	if (category === 'fast_food') return 'Fast food';
	return category.charAt(0).toUpperCase() + category.slice(1);
}
