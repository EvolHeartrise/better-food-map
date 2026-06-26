-- Migration 0010: ingredient canonicalization map.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Ingredient tags are DATA, minted from each item's free-text `ingredients`
-- (id `ing:<name>`). The name IS the identity, so every spelling variant became a
-- DISTINCT tag: "tomato" vs "tomatoes", "jalapeno" vs "jalapeño", "chickpea" vs
-- "garbanzo" — fragmenting the vocabulary the tag filter searches and splitting an
-- ingredient's items across several tags.
--
-- This table is the single source of truth that collapses those variants. Accent
-- folding is handled deterministically in code (foldIngredientName, $lib/tags); the
-- NON-rule-derivable variants — plurals and synonyms — live here as rows:
--   alias 'tomatoes'        -> canonical_id 'ing:tomato'
--   alias 'garbanzo beans'  -> canonical_id 'ing:chickpea'
-- A variant is NOT itself a `tags` row — it exists only as an alias pointing at the
-- canonical, so `item_tags` only ever references canonical tags and the filter shows
-- one option per ingredient.
--
-- Consulted on BOTH sides of the data flow, so the mapping is shared, not duplicated:
--   * WRITE (db.ts ingredientLinkStmts): an incoming ingredient name is redirected
--     to its canonical tag, so new menus never re-fragment.
--   * READ  (db.ts searchTagVocabulary): the tag filter's picker matches alias
--     spellings too, returning the canonical tag — so a user typing "tomatoes" or
--     "jalapeño" finds the canonical "tomato" tag and all of its items.
--
-- The table is small and curated, so searchTagVocabulary scans it with a plain LIKE
-- (no FTS index needed, unlike the much larger `tags` table in migration 0006).
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout, so re-applying is a no-op. The
-- variant -> canonical rows themselves are seeded/merged by the one-time
-- scripts/canonicalize-ingredients.ts (run separately), not by this migration.

CREATE TABLE IF NOT EXISTS ingredient_aliases (
	-- The variant spelling, already accent-folded / lower-cased / whitespace-collapsed
	-- by foldIngredientName, so it matches what the write path looks up.
	alias TEXT PRIMARY KEY,
	-- The canonical ingredient tag this variant maps to (always an `ing:<name>` id).
	canonical_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	-- Provenance of the mapping, for auditing the seed: 'diacritic' | 'plural' |
	-- 'synonym' | 'manual'. Nullable; advisory only.
	source TEXT
);

-- Index the canonical side so "what variants map here?" (and the ON DELETE CASCADE
-- cleanup when a canonical tag is removed) is a lookup, not a scan.
CREATE INDEX IF NOT EXISTS idx_ingredient_aliases_canonical ON ingredient_aliases (canonical_id);
