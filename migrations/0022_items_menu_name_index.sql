-- Migration 0022: composite index on items (menu_id, item_name).
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- WHY: the map-data read (src/lib/server/db.ts) fetches items with
-- `WHERE menu_id IN (…) ORDER BY menu_id, item_name`, and getItemsByMenu runs
-- `WHERE menu_id = ? ORDER BY item_name`. The only items index was the
-- single-column idx_items_menu_id (migration 0004), which satisfies the WHERE
-- but not the ORDER BY, so SQLite added a `USE TEMP B-TREE FOR ORDER BY` step
-- on every uncached read. A composite (menu_id, item_name) index satisfies
-- both the predicate and the sort for both queries — verified with
-- EXPLAIN QUERY PLAN: the temp B-tree steps vanish, with zero query changes.
--
-- The old single-column index is dropped: the composite index is a strict
-- superset for any menu_id-only lookup, so keeping both would only cost
-- write amplification and space.
--
-- ADDITIVE and backward-compatible: no query text changes meaning either way,
-- so this can be applied before or after any deploy. Idempotent: DROP INDEX
-- IF EXISTS + CREATE INDEX IF NOT EXISTS, so re-applying is a no-op.

DROP INDEX IF EXISTS idx_items_menu_id;
CREATE INDEX IF NOT EXISTS idx_items_menu_id_name ON items (menu_id, item_name);
