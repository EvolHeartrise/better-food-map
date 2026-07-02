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
// from ingredients. Items carry no ingredient tags, so these positive designations
// are the only safe, source-backed signal to filter on.

import { TAGS } from './tags';

/** A selectable diet: its curated dietary tag id and the label shown in the UI. */
export interface DietOption {
	/** Curated dietary tag id to filter on (an id from the TAGS vocabulary, $lib/tags). */
	id: string;
	/** Label shown in the selector. */
	label: string;
}

// The source-asserted dietary tags in display order, DERIVED from the canonical
// TAGS vocabulary ($lib/tags) so the selector can never drift from the tags items
// actually carry — the labels are the tags' own display names.
export const DIET_OPTIONS: readonly DietOption[] = TAGS.filter(
	(tag) => tag.tag_type === 'dietary'
).map((tag) => ({ id: tag.id, label: tag.name }));

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
