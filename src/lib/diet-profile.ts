// The dietary-profile vocabulary: the restrictions and allergies a signed-in user
// can save to PRE-APPLY as default search filters. Kept here — client-safe, with no
// `$lib/server` import — so the editor UI (DietProfileModal) and the server resolver
// (resolveDietProfileFilters in $lib/server/db) share ONE source of truth for what
// each selection means, mirroring how `$lib/tags` / `$lib/category` stay server-free.
//
// A profile stores stable catalog KEYS (see migration 0013), not resolved tag ids,
// so the key→filter mapping below can change without a data migration. Two filter
// effects come out of a profile, matching the map's existing include/exclude model:
//   • INCLUDE a curated dietary tag — the source-asserted, positive designation
//     ("Vegan", "Nut-free"). This is the safe primary signal: it shows only items a
//     source explicitly marked, never something inferred.
//   • EXCLUDE allergen ingredient tags — drop any item whose ingredient list NAMES
//     the allergen ("peanut", "milk"). This is best-effort and additive: a missing
//     ingredient is NOT proof an item is free of the allergen, so exclusion narrows
//     the list but can never guarantee safety. The UI states this caveat.
//
// Allergens that have a matching "-free" dietary tag (gluten/dairy/nuts) contribute
// BOTH effects; the rest (egg/soy/shellfish/fish/sesame) have no positive tag in the
// vocabulary, so they contribute ingredient exclusion only.

/** A user's saved selections: stable keys into the catalogs below. */
export interface DietProfile {
	restrictions: string[];
	allergies: string[];
}

export const EMPTY_DIET_PROFILE: DietProfile = { restrictions: [], allergies: [] };

/** A lifestyle restriction: include its curated dietary tag. */
export interface DietaryRestrictionDef {
	/** Stable key stored in the profile. */
	key: string;
	/** Label shown in the editor. */
	label: string;
	/** Curated dietary tag id to INCLUDE (must match an id in TAGS / $lib/server/db). */
	tag: string;
}

/** An allergen: optionally include a "-free" tag, and exclude its ingredient tags. */
export interface AllergenDef {
	/** Stable key stored in the profile. */
	key: string;
	/** Label shown in the editor. */
	label: string;
	/**
	 * Curated "-free" dietary tag id to INCLUDE when one exists for this allergen
	 * (gluten_free, dairy_free, nut_free); omitted for allergens with no such tag.
	 */
	tag?: string;
	/**
	 * Ingredient names to EXCLUDE. Matched (alias- and accent-aware) against the
	 * ingredient tag vocabulary on the server; a name with no tag simply matches
	 * nothing. Kept as generic component nouns to mirror the ingredient-tag standard.
	 */
	ingredients: string[];
}

export const DIETARY_RESTRICTIONS: readonly DietaryRestrictionDef[] = [
	{ key: 'vegan', label: 'Vegan', tag: 'vegan' },
	{ key: 'vegetarian', label: 'Vegetarian', tag: 'vegetarian' },
	{ key: 'halal', label: 'Halal', tag: 'halal' }
];

export const ALLERGENS: readonly AllergenDef[] = [
	{
		key: 'gluten',
		label: 'Gluten / wheat',
		tag: 'gluten_free',
		ingredients: ['wheat', 'barley', 'rye', 'malt', 'gluten', 'flour']
	},
	{
		key: 'dairy',
		label: 'Dairy',
		tag: 'dairy_free',
		ingredients: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'ghee', 'whey', 'buttermilk']
	},
	{
		key: 'nuts',
		label: 'Tree nuts & peanuts',
		tag: 'nut_free',
		ingredients: [
			'peanut',
			'almond',
			'cashew',
			'walnut',
			'pecan',
			'hazelnut',
			'pistachio',
			'macadamia',
			'brazil nut',
			'pine nut'
		]
	},
	{ key: 'egg', label: 'Egg', ingredients: ['egg'] },
	{
		key: 'soy',
		label: 'Soy',
		ingredients: ['soy', 'soybean', 'tofu', 'edamame', 'soy sauce', 'miso']
	},
	{
		key: 'shellfish',
		label: 'Shellfish',
		ingredients: [
			'shrimp',
			'prawn',
			'crab',
			'lobster',
			'oyster',
			'clam',
			'mussel',
			'scallop',
			'crayfish'
		]
	},
	{
		key: 'fish',
		label: 'Fish',
		ingredients: ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'tilapia', 'haddock', 'sardine']
	},
	{ key: 'sesame', label: 'Sesame', ingredients: ['sesame', 'tahini'] }
];

const RESTRICTION_BY_KEY = new Map(DIETARY_RESTRICTIONS.map((r) => [r.key, r]));
const ALLERGEN_BY_KEY = new Map(ALLERGENS.map((a) => [a.key, a]));

/** Valid restriction keys, for sanitizing untrusted input before storing. */
export const RESTRICTION_KEYS: ReadonlySet<string> = new Set(RESTRICTION_BY_KEY.keys());
/** Valid allergen keys, for sanitizing untrusted input before storing. */
export const ALLERGEN_KEYS: ReadonlySet<string> = new Set(ALLERGEN_BY_KEY.keys());

/** Drops unknown keys and de-duplicates, so only catalog keys are ever stored. */
export function sanitizeProfile(profile: DietProfile): DietProfile {
	return {
		restrictions: [...new Set(profile.restrictions.filter((k) => RESTRICTION_KEYS.has(k)))],
		allergies: [...new Set(profile.allergies.filter((k) => ALLERGEN_KEYS.has(k)))]
	};
}

/**
 * The curated dietary tag ids a profile should INCLUDE: every selected lifestyle
 * restriction's tag, plus each selected allergen's "-free" tag when it has one.
 * De-duplicated. Unknown keys are ignored.
 */
export function profileIncludeTagIds(profile: DietProfile): string[] {
	const ids = new Set<string>();
	for (const key of profile.restrictions) {
		const r = RESTRICTION_BY_KEY.get(key);
		if (r) ids.add(r.tag);
	}
	for (const key of profile.allergies) {
		const a = ALLERGEN_BY_KEY.get(key);
		if (a?.tag) ids.add(a.tag);
	}
	return [...ids];
}

/**
 * The ingredient names a profile should EXCLUDE: the union of every selected
 * allergen's ingredient list. De-duplicated; the server folds/resolves these to
 * ingredient tags. Unknown keys are ignored.
 */
export function profileExcludeIngredientNames(profile: DietProfile): string[] {
	const names = new Set<string>();
	for (const key of profile.allergies) {
		const a = ALLERGEN_BY_KEY.get(key);
		if (!a) continue;
		for (const name of a.ingredients) names.add(name);
	}
	return [...names];
}

/** True when a profile has no selections at all. */
export function isEmptyProfile(profile: DietProfile): boolean {
	return profile.restrictions.length === 0 && profile.allergies.length === 0;
}
