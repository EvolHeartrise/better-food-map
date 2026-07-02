// The canonical tag vocabulary and its client-safe display helpers. Kept here
// (not in `$lib/server/db`, which is server-only) so client components and the
// diet selector can share the ONE tag catalog without pulling server code into
// the browser bundle — mirrors `$lib/category.ts`. `$lib/server/db` re-exports
// everything below as part of its stable contract.

// Canonical, app-defined tag identifiers (dietary + course). These are part of
// the app contract and fixed — they are NOT user-authored, so this union is the
// single source of truth.
export type TagId =
	| 'vegan'
	| 'vegetarian'
	| 'gluten_free'
	| 'dairy_free'
	| 'nut_free'
	| 'halal'
	| 'dessert'
	| 'drink';

/**
 * What a tag describes. `dietary` tags (vegan, halal, …) are source-asserted —
 * only applied when a source explicitly designates the item. `course` tags
 * (dessert, drink) describe what kind of item it is and are applied factually.
 */
export type TagType = 'dietary' | 'course';

export interface Tag {
	id: string;
	name: string;
	tag_type: TagType;
}

// The canonical tag list (dietary first, then course) — the display/filter order
// on the frontend. These are app-defined, never created from the UI, and seeded
// into D1 by migrations/0001_init.sql (renamed to (name, tag_type) by 0004). This
// is the WHOLE tag vocabulary: there are no data-created tags.
export const TAGS: readonly Tag[] = [
	{ id: 'vegan', name: 'Vegan', tag_type: 'dietary' },
	{ id: 'vegetarian', name: 'Vegetarian', tag_type: 'dietary' },
	{ id: 'gluten_free', name: 'Gluten-free', tag_type: 'dietary' },
	{ id: 'dairy_free', name: 'Dairy-free', tag_type: 'dietary' },
	{ id: 'nut_free', name: 'Nut-free', tag_type: 'dietary' },
	{ id: 'halal', name: 'Halal', tag_type: 'dietary' },
	{ id: 'dessert', name: 'Dessert', tag_type: 'course' },
	{ id: 'drink', name: 'Drink', tag_type: 'course' }
];

/**
 * How a tag's name should read in the UI. Curated dietary/course tags are stored
 * already capitalised ("Vegan", "Dessert"); title-casing the first letter is a
 * harmless no-op for them and keeps the helper robust if a lower-cased name ever
 * reaches it. Applied in one place — {@link FoodTag} — so a tag reads the same
 * wherever it appears.
 */
export function tagDisplayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}
