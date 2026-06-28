-- Migration 0014: remove ingredient tags and simplify the dietary filter.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- The app drops ingredient tags entirely. The map's freeform include/exclude tag
-- filter (which searched the ingredient vocabulary) is replaced by a single-select
-- dietary selector over the curated, source-asserted dietary tags only
-- (vegan/vegetarian/gluten_free/dairy_free/nut_free/halal). With ingredient tags
-- gone, every structure that existed to store, canonicalize, search or suggest them
-- is dead weight, so this migration tears all of it down:
--
--   1. tags_fts (migration 0006) — an FTS5 trigram index that existed only to make
--      `name LIKE '%q%'` over the thousands of ingredient rows cheap. With just the
--      eight curated tags left, substring search is gone; drop the index + triggers.
--   2. ingredient_aliases (migration 0010) — the plural/synonym canonicalization map
--      for ingredient tags. No ingredients, no aliases.
--   3. Every `ingredient`-typed row in `tags`. Their `item_tags` edges cascade
--      (ON DELETE CASCADE), so this also clears the links; the curated dietary/course
--      tags (and their item links) are untouched.
--   4. search_history (migration 0007) — auto-logged searches existed ONLY to feed
--      the tag pickers' suggestion lists. With the pickers gone there is no consumer,
--      so the table and its logging are removed.
--   5. user_dietary_profile (migration 0013) — reshaped from two JSON arrays
--      (restrictions[] + allergies[]) to a single nullable `diet` tag id, matching
--      the new single-select selector (the selector IS the saved profile).
--
-- Idempotent where it can be (IF EXISTS throughout). The table rebuild in step 5
-- runs once; re-applying the migration is prevented by the migrations ledger.

-- ---------------------------------------------------------------------------
-- 1. Drop the tag-name FTS index and the triggers that kept it in sync.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS tags_fts_ai;
DROP TRIGGER IF EXISTS tags_fts_au;
DROP TRIGGER IF EXISTS tags_fts_ad;
DROP TABLE IF EXISTS tags_fts;

-- ---------------------------------------------------------------------------
-- 2. Drop the ingredient canonicalization map.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS ingredient_aliases;

-- ---------------------------------------------------------------------------
-- 3. Delete every ingredient tag. The item_tags edges referencing them are
--    removed by the foreign key's ON DELETE CASCADE (D1 enforces foreign keys).
-- ---------------------------------------------------------------------------
DELETE FROM tags WHERE tag_type = 'ingredient';

-- ---------------------------------------------------------------------------
-- 4. Drop the search history (it only ever fed the removed tag pickers).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS search_history;

-- ---------------------------------------------------------------------------
-- 5. Reshape user_dietary_profile to a single selected diet.
--    SQLite can't drop several columns and add one in place, so rebuild the
--    table. The selector is single-select now, so a multi-select profile can't
--    be carried over faithfully; we best-effort keep the first stored restriction
--    that is itself a dietary tag id (vegan/vegetarian/halal) and drop the rest
--    (allergen selections no longer have a filtering mechanism). Most profiles
--    pre-date this change and simply reset to NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE user_dietary_profile_new (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	-- A single curated dietary tag id to pre-apply as the map's filter, or NULL for
	-- "no filter". Always one of the source-asserted dietary tag ids (see TAGS in
	-- src/lib/server/db.ts); validated in code before write.
	diet TEXT REFERENCES tags(id) ON DELETE SET NULL,
	updated_at INTEGER NOT NULL
);

INSERT INTO user_dietary_profile_new (user_id, diet, updated_at)
SELECT
	user_id,
	(SELECT j.value FROM json_each(restrictions) j
	 WHERE j.value IN ('vegan', 'vegetarian', 'halal') LIMIT 1),
	updated_at
FROM user_dietary_profile;

DROP TABLE user_dietary_profile;
ALTER TABLE user_dietary_profile_new RENAME TO user_dietary_profile;
