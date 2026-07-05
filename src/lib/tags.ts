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
// on the frontend (e.g. the diet selector's option order). These are app-defined,
// never created from the UI, and seeded into D1 by migrations/0001_init.sql
// (renamed to (name, tag_type) by 0004); this array — not the DB row order — is the
// authoritative display order. The dietary tags are grouped by kind: the positive
// diets (vegan, vegetarian, halal) first, then the "-free" allergen-avoidance tags
// (gluten/dairy/nut) — matching the green/orange split the icons use. This is the
// WHOLE tag vocabulary: there are no data-created tags.
export const TAGS: readonly Tag[] = [
	{ id: 'vegan', name: 'Vegan', tag_type: 'dietary' },
	{ id: 'vegetarian', name: 'Vegetarian', tag_type: 'dietary' },
	{ id: 'halal', name: 'Halal', tag_type: 'dietary' },
	{ id: 'gluten_free', name: 'Gluten-free', tag_type: 'dietary' },
	{ id: 'dairy_free', name: 'Dairy-free', tag_type: 'dietary' },
	{ id: 'nut_free', name: 'Nut-free', tag_type: 'dietary' },
	{ id: 'dessert', name: 'Dessert', tag_type: 'course' },
	{ id: 'drink', name: 'Drink', tag_type: 'course' }
];

// ---------------------------------------------------------------------------
// Dietary-tag implication (vegan ⊃ vegetarian, dairy-free)
// ---------------------------------------------------------------------------

// An ASSERTED vegan designation logically entails these two: a vegan dish is by
// definition vegetarian and contains no dairy. Storing/showing the entailed tags
// alongside vegan is therefore pure redundancy, so writes strip them, the icon
// row hides them, and the diet filter matches vegan items under either entailed
// diet. Halal is deliberately NOT here — vegan food can still be non-halal
// (e.g. alcohol), so halal stays independent: always stored, always shown, and
// its filter matches only explicitly halal-tagged items. An OPTIONAL vegan tag
// ("can be made vegan") never dominates — only the asserted form entails.
export const DIET_TAG_IMPLIES: Partial<Record<TagId, readonly TagId[]>> = {
	vegan: ['vegetarian', 'dairy_free']
};

/**
 * The tag ids whose presence on an item satisfies the diet filter `diet`: the
 * diet itself plus any tag that entails it (Vegetarian and Dairy-free each also
 * match vegan-tagged items). Both filter halves — `searchMembership` in
 * `$lib/server/db` and the client mirror in `$lib/search-match` — resolve the
 * selected diet through this ONE closure so they can't drift. Matching stays
 * optional-agnostic like the base filter: "can be made vegan" already matches
 * the Vegan filter, and can-be-made-vegan entails can-be-made-vegetarian, so
 * the same looseness carries over soundly.
 */
export function dietFilterTagIds(diet: string): string[] {
	const ids = [diet];
	for (const [implier, implied] of Object.entries(DIET_TAG_IMPLIES)) {
		if (implied.includes(diet as TagId)) ids.push(implier);
	}
	return ids;
}

/**
 * The tag ids made redundant by the item's ASSERTED tags — e.g. an item with a
 * non-optional vegan tag makes vegetarian/dairy_free redundant (in either their
 * asserted or optional form: a vegan dish "can be made vegetarian" says
 * nothing). Optional tags never dominate. Used by the icon row to hide
 * redundant marks and by the item-write path to strip them before they're
 * stored.
 */
export function impliedDietTagIds(
	tags: ReadonlyArray<{ id: string; optional: boolean }>
): Set<string> {
	const implied = new Set<string>();
	for (const tag of tags) {
		if (tag.optional) continue;
		for (const id of DIET_TAG_IMPLIES[tag.id as TagId] ?? []) implied.add(id);
	}
	return implied;
}

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
