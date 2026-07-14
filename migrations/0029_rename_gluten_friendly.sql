-- Migration 0029: rename the `gluten_free` dietary tag to `gluten_friendly`.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Product rename of the gluten dietary tag from "gluten-free" to "gluten-friendly"
-- across the whole app (tag id, display label, browse slug, MCP vocabulary, agent
-- prompts). The tag id is DATA — stored on every tagged item (item_tags.tag_id)
-- and as a user's saved map diet (user_dietary_profile.diet) — so the app-code
-- rename alone would orphan those rows. This migration re-points them.
--
-- Order is FK-safe (D1 enforces foreign keys): create the new tag row FIRST so the
-- re-pointed children satisfy their tags(id) reference, move every child edge, then
-- drop the old row. By the time it is deleted nothing references it, so neither
-- item_tags' ON DELETE CASCADE nor user_dietary_profile.diet's ON DELETE SET NULL
-- can touch the migrated rows. No item can hold both ids (gluten_friendly is brand
-- new), so the item_tags PRIMARY KEY (item_id, tag_id) never collides.

-- 1. The renamed vocabulary row (same tag_type; display name mirrors src/lib/tags.ts).
INSERT INTO tags (id, name, tag_type) VALUES ('gluten_friendly', 'Gluten-friendly', 'dietary');

-- 2. Re-point every item that carried the old tag.
UPDATE item_tags SET tag_id = 'gluten_friendly' WHERE tag_id = 'gluten_free';

-- 3. Re-point users whose saved map diet was the old tag.
UPDATE user_dietary_profile SET diet = 'gluten_friendly' WHERE diet = 'gluten_free';

-- 4. Remove the old, now-unreferenced vocabulary row.
DELETE FROM tags WHERE id = 'gluten_free';
