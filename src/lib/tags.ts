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
const PROSE_WORDS =
	/\b(served|serves|serving|topped|drizzled|sprinkled|smothered|tossed|wrapped|filled|soaked|marinated|garnished|comes|choice|includes|make|add|sub|with)\b/i;

/**
 * Heuristic: does this single comma-separated "ingredient" actually read like a
 * dish description, price, or serving note rather than one component noun? Returns
 * a short human reason when it does, else `null`.
 *
 * ADVISORY ONLY — never blocks a write. The MCP server surfaces the reason as a
 * warning so an agent can move prose into the item `description` and keep
 * `ingredients` to component nouns (see the ingredient-tag standard). The signals
 * are deliberately high-precision (digits, sentence punctuation, prep verbs) so a
 * legitimate compound ingredient ("extra virgin olive oil", "san marzano tomato")
 * passes clean; length / word-count are last-resort soft signals.
 */
export function ingredientProseWarning(part: string): string | null {
	const s = part.trim();
	if (s === '') return null;
	if (/\d/.test(s))
		return 'contains a number — prices, sizes and quantities belong in `description`, not `ingredients`';
	if (/[.;:()]/.test(s))
		return 'contains sentence punctuation (. ; : or parentheses) — reads like prose, not one ingredient';
	if (/\s\/\s/.test(s))
		return 'contains a choice separator ("/") — list each option as its own ingredient or move it to `description`';
	if (s.length > 50)
		return 'is unusually long for an ingredient — likely a description; keep `ingredients` to component nouns';
	if (PROSE_WORDS.test(s))
		return 'reads like a preparation/serving description — put that in `description` and list only component nouns';
	if (s.split(/\s+/).length > 6)
		return 'has many words for an ingredient — likely a description; keep `ingredients` to component nouns';
	return null;
}
