-- Migration 0021: consolidate ALL provenance to the MENU level.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Sources used to live at three levels — `location_sources`, `item_sources` and
-- `menu_sources` — with reads merging an item's own sources with its menu's, and a
-- location's shown on its own. The app only needs MENU-level provenance: where the
-- menu / official nutrition / dietary data came from (the users care that the food
-- data is accurate, not which pin cited which URL). This folds the per-location and
-- per-item sources up into `menu_sources` and drops the two tables.
--
-- Every item belongs to a menu, and every open venue with data serves a menu (a
-- private one for an independent venue, a shared one for a chain branch), so both
-- fold up cleanly. De-duplication is automatic: `menu_sources`' (menu_id, url)
-- primary key + INSERT OR IGNORE collapses a URL cited on many items of a menu (or
-- on both a location and its items) to a single menu-level row.

-- 1. Fold each item's sources into the menu that owns the item.
INSERT OR IGNORE INTO menu_sources (menu_id, url, label)
SELECT i.menu_id, s.url, s.label
FROM item_sources s
JOIN items i ON i.id = s.item_id;

-- 2. Fold each location's sources into the menu it serves. A location with no menu
--    (a born-closed tombstone, or one not yet given a menu) has nowhere to fold to,
--    so its sources are dropped here — closure evidence for those also lives in
--    `locations.closed_reason` (migration 0015), which is unaffected.
INSERT OR IGNORE INTO menu_sources (menu_id, url, label)
SELECT l.menu_id, s.url, s.label
FROM location_sources s
JOIN locations l ON l.id = s.location_id
WHERE l.menu_id IS NOT NULL;

-- 3. Drop the now-superseded per-location and per-item source tables. Their indexes
--    (idx_location_sources_location_id, idx_item_sources_item_id) drop with them.
DROP TABLE location_sources;
DROP TABLE item_sources;
