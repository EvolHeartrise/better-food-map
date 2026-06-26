// Shared, client-safe tag display helpers. Kept here (not in `$lib/server/db`,
// which is server-only) so client components can format tags without pulling
// server code into the browser bundle — mirrors `$lib/category.ts`.

/**
 * How a tag's name should read in the UI. Curated dietary/course tags are stored
 * already capitalised ("Vegan", "Dessert"), but ingredient tag names are stored
 * lower-cased (e.g. "tomato"); title-casing the first letter lets them sit
 * comfortably beside the curated tags. Applied in one place — {@link FoodTag} and
 * the tag picker's aria labels — so a tag reads the same wherever it appears.
 */
export function tagDisplayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Folds an ingredient name to its canonical identity form: lower-cases,
 * decomposes accents (NFD) and strips the combining marks so "Jalapeño" and
 * "jalapeno" collapse to one identity, and normalizes whitespace. This is the
 * DETERMINISTIC, rule-safe half of ingredient canonicalization; the non-derivable
 * half (plurals, synonyms like garbanzo↔chickpea) lives in the `ingredient_aliases`
 * table. Applied on the write path (`parseIngredients` in `$lib/server/db`) and by
 * the alias-seed script, so a name is folded identically wherever it is canonicalized.
 */
export function foldIngredientName(raw: string): string {
	return raw
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

// Standalone words whose presence betrays a preparation/serving description
// rather than a component noun. Matched case-insensitively on word boundaries.
// "marinated" is intentionally absent: like smoked/pickled/dried it is a
// transformation-defining prep that yields a distinct product ("marinated tofu"),
// kept per the fold/keep policy — so it must not read as prose here.
const PROSE_WORDS =
	/\b(served|serves|serving|topped|drizzled|sprinkled|smothered|tossed|wrapped|filled|soaked|garnished|comes|choice|includes|make|add|sub|with)\b/i;

// A conjunction joining two components: the part names MORE THAN ONE ingredient
// and must be split into atomic, comma-separated ingredients ("beets & cilantro"
// → "beets, cilantro"). "with" is covered by PROSE_WORDS above.
const CONJUNCTION = /\s(?:and|plus)\s|&/i;

// A process / sequence / location clause ("steamed THEN fried", "baked IN the
// tandoor", "braised IN yogurt"): describes how or where a component was prepared,
// so the part reads as prose rather than one named ingredient.
const PROCESS_CLAUSE = /\bthen\b|\bin\b/i;

// Leading qualifiers that FRAGMENT an ingredient: they describe how a component was
// cooked, cut or sourced — not WHAT it is — so the component noun is the real
// ingredient ("grilled chicken", "whole chicken" and "house chicken" all reduce to
// "chicken"). Anchored to the START so a compound whose qualifier IS its identity is
// left alone: transformation preps that yield a distinct product (smoked, pickled,
// dried, fermented, battered, breaded, candied, marinated, whipped) and seasoning
// words (spiced) are deliberately ABSENT, matching the fold/keep policy recorded in
// scripts/fold-classifications.json. Temperature words (hot, cold) are absent too so
// idioms like "hot sauce" / "cold brew" pass clean.
const PREP_QUALIFIER =
	/^(?:deep[ -]?fried|pan[ -]?fried|stir[ -]?fried|pan[ -]?seared|char[ -]?grilled|char[ -]?roasted|charcoal[ -]?grilled|flame[ -]?grilled|slow[ -]?braised|slow[ -]?cooked|tandoor[ -]?(?:baked|grilled|roasted)|fried|grilled|steamed|roasted|baked|braised|seared|poached|boiled|saut(?:é|e)ed|griddled|blanched|parboiled|charred|tandoor)\b/i;
const FORM_QUALIFIER =
	/^(?:chopped|diced|ground|shredded|minced|grated|crushed|cubed|julienned|mashed|sliced|halved|quartered|crumbled|flaked|shaved|whole)\b/i;
const SOURCING_QUALIFIER =
	/^(?:house[ -]?made|housemade|house|home[ -]?made|homemade|local|fresh)\b/i;
// "whole" / "fresh" lead a few genuine compound ingredients whose first word is part
// of the identity (a fat level, a grain, a water) rather than a cut or freshness
// qualifier — exempt those from the cut-form / sourcing checks.
const QUALIFIER_IDIOM = /^(?:whole[ -](?:wheat|grain|grains|milk)|fresh water)\b/i;

/**
 * Heuristic: does this single comma-separated "ingredient" actually read like a
 * dish description, a preparation/cut/sourcing qualifier, or a list of several
 * components, rather than one canonical component noun? Returns a short human reason
 * when it does, else `null`.
 *
 * ADVISORY ONLY — never blocks a write. The MCP server surfaces the reason as a
 * warning so an agent splits conjunctions, drops prep/cut/sourcing qualifiers down to
 * the base noun, and moves prose into the item `description` (see the ingredient-tag
 * standard). The signals are ordered most- to least-specific. The qualifier checks are
 * anchored to the leading word and exclude transformation preps (smoked/pickled/dried/…)
 * and idioms (hot sauce, whole wheat, oat milk), so genuinely distinct compound
 * ingredients ("extra virgin olive oil", "san marzano tomato", "smoked paprika",
 * "whipped cream", "coconut milk") pass clean; length / word-count are last-resort soft
 * signals.
 */
export function ingredientProseWarning(part: string): string | null {
	const s = part.trim();
	if (s === '') return null;
	if (/\d/.test(s))
		return 'contains a number — prices, sizes and quantities belong in `description`, not `ingredients`';
	if (/[.;:()]/.test(s))
		return 'contains sentence punctuation (. ; : or parentheses) — reads like prose, not one ingredient';
	if (/\//.test(s))
		return 'contains a slash ("/") — list each option as its own comma-separated ingredient or move the choice to `description`';
	if (CONJUNCTION.test(s))
		return 'joins more than one component with "and"/"&" — list each as its own comma-separated ingredient (split "beets & cilantro" into "beets, cilantro")';
	if (PROCESS_CLAUSE.test(s))
		return 'reads like a preparation step ("… then …", "… in …") — name only the component noun and put the method in `description`';
	if (PREP_QUALIFIER.test(s))
		return 'leads with a cooking-method qualifier — name the base ingredient instead ("chicken", not "grilled chicken")';
	if (FORM_QUALIFIER.test(s) && !QUALIFIER_IDIOM.test(s))
		return 'leads with a cut/form qualifier — name the base ingredient instead ("chicken", not "whole chicken")';
	if (SOURCING_QUALIFIER.test(s) && !QUALIFIER_IDIOM.test(s))
		return 'leads with a sourcing/freshness qualifier — drop it and name the ingredient ("fries", not "house fries"; "mozzarella", not "fresh mozzarella")';
	if (s.length > 50)
		return 'is unusually long for an ingredient — likely a description; keep `ingredients` to component nouns';
	if (PROSE_WORDS.test(s))
		return 'reads like a preparation/serving description — put that in `description` and list only component nouns';
	if (s.split(/\s+/).length > 6)
		return 'has many words for an ingredient — likely a description; keep `ingredients` to component nouns';
	return null;
}
