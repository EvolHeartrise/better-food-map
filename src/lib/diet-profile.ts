// The dietary selector's vocabulary: the source-asserted dietary tags a signed-in
// user can pick to filter the map. Kept here — client-safe, with no `$lib/server`
// import — so the selector UI (DietSelector) and the server (setDiet validation,
// the search filter) share ONE source of truth, mirroring how `$lib/tags` /
// `$lib/category` stay server-free.
//
// The selector is SINGLE-SELECT and IS the saved profile: a user picks at most one
// diet, persisted per user (see migration 0014's `user_dietary_profile.diet`) and
// pre-applied on every visit. Selecting a diet shows only items a SOURCE explicitly
// marked with that designation (the curated dietary tags) — never something inferred
// from ingredients. Allergen-style exclusion no longer exists: with ingredient tags
// removed, the only safe, source-backed signal is these positive designations.

/** A selectable diet: its curated dietary tag id and the label shown in the UI. */
export interface DietOption {
	/** Curated dietary tag id to filter on (must match an id in TAGS / $lib/server/db). */
	id: string;
	/** Label shown in the selector. */
	label: string;
}

// The six source-asserted dietary tags, in display order. Labels mirror the `name`
// of the matching `dietary` rows in TAGS (src/lib/server/db.ts); kept in step by hand.
export const DIET_OPTIONS: readonly DietOption[] = [
	{ id: 'vegan', label: 'Vegan' },
	{ id: 'vegetarian', label: 'Vegetarian' },
	{ id: 'gluten_free', label: 'Gluten-free' },
	{ id: 'dairy_free', label: 'Dairy-free' },
	{ id: 'nut_free', label: 'Nut-free' },
	{ id: 'halal', label: 'Halal' }
];

/** The valid diet tag ids, for sanitizing untrusted input before storing/filtering. */
export const DIET_IDS: ReadonlySet<string> = new Set(DIET_OPTIONS.map((o) => o.id));

/**
 * Narrows an arbitrary value to a valid diet tag id, or `null` ("no filter").
 * Used on the write path (before persisting a selection) and on the read path
 * (before applying a stored value as a filter), so an unknown/dropped id is simply
 * treated as no selection rather than filtering on a tag that can't render.
 */
export function sanitizeDiet(id: string | null | undefined): string | null {
	return typeof id === 'string' && DIET_IDS.has(id) ? id : null;
}
