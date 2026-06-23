-- Migration 0004: unify the menu-item and tag model.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Two structural changes that collapse the previous duplication:
--
--   1. ONE items table. Before, an independent venue's menu lived in `food`
--      (owned by a location) while a chain's lived in `menu_items` (owned by a
--      menu) — two parallel tables, each with its own tag/source link tables.
--      Now there is a single `items` table owned by a `menu`. An independent
--      venue gets its own PRIVATE menu (brand_id NULL, referenced by just that
--      one location); a chain branch keeps referencing its shared brand menu, as
--      before. So every item belongs to a menu, and a location's effective menu
--      is always "the items of locations.menu_id, with this location's overrides
--      applied" — no more per-table branching.
--
--   2. ONE tag vocabulary, with ingredients folded in. `tags` is renamed to
--      (id, name, tag_type) and gains a third tag_type, 'ingredient', alongside
--      'dietary' and 'course'. The free-text `ingredients` column on each item is
--      parsed into ingredient tags (one per comma-separated part, lower-cased and
--      trimmed for de-duplication) and linked through the single `item_tags`
--      table, which carries an `optional` flag per (item, tag) edge — e.g. an item
--      that can be made vegan on request, or have an ingredient left out.
--
-- D1 enforces foreign keys, so ON DELETE CASCADE is honoured and the table
-- drops below run as implicit cascading deletes. Ordering matters: new tables
-- are populated from the old ones before anything is dropped.

-- ---------------------------------------------------------------------------
-- 1. Rename the tag vocabulary columns. The 'ingredient' tag_type is just a new
--    value of the existing column, so no schema change is needed for it.
-- ---------------------------------------------------------------------------
ALTER TABLE tags RENAME COLUMN label TO name;
ALTER TABLE tags RENAME COLUMN kind TO tag_type;

-- ---------------------------------------------------------------------------
-- 2. New unified tables.
-- ---------------------------------------------------------------------------

-- A menu item, owned by a menu (private to one venue, or shared across a chain).
-- Note: no `ingredients` column — ingredients are now tags (see step 5).
CREATE TABLE IF NOT EXISTS items (
	id TEXT PRIMARY KEY,
	menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
	item_name TEXT NOT NULL,
	description TEXT,
	price REAL
);

CREATE INDEX IF NOT EXISTS idx_items_menu_id ON items (menu_id);

-- Tags applied to an item. `optional` = 1 means the tag/ingredient is optional
-- for this item (can be added or left out, e.g. "can be made vegan").
CREATE TABLE IF NOT EXISTS item_tags (
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	optional INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag_id ON item_tags (tag_id);

-- Provenance per item (same shape as the former food_sources / menu_item_sources).
CREATE TABLE IF NOT EXISTS item_sources (
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	label TEXT,
	PRIMARY KEY (item_id, url)
);

CREATE INDEX IF NOT EXISTS idx_item_sources_item_id ON item_sources (item_id);

-- ---------------------------------------------------------------------------
-- 3. Give every independent venue (a location with its own `food`, hence no
--    shared menu) a private menu, and point the location at it. The private
--    menu's id is derived from the location id so the copy in step 4 can join
--    to it without a round-trip. Chain branches already have a menu_id and are
--    left untouched.
-- ---------------------------------------------------------------------------
INSERT INTO menus (id, brand_id, name, region, last_verified)
SELECT 'pm-' || l.id, NULL, l.name, NULL, NULL
FROM locations l
WHERE l.menu_id IS NULL
	AND EXISTS (SELECT 1 FROM food f WHERE f.location_id = l.id);

UPDATE locations
SET menu_id = 'pm-' || locations.id
WHERE locations.menu_id IS NULL
	AND EXISTS (SELECT 1 FROM food f WHERE f.location_id = locations.id);

-- ---------------------------------------------------------------------------
-- 4. Copy both old item tables into `items`. Ids are preserved, so all existing
--    tag/source/override links remain valid when re-pointed below.
--    (food.ingredients / menu_items.ingredients are intentionally dropped here;
--    they are migrated to tags in step 5.)
-- ---------------------------------------------------------------------------
INSERT INTO items (id, menu_id, item_name, description, price)
SELECT f.id, m.id, f.item_name, f.description, f.price
FROM food f
JOIN menus m ON m.id = 'pm-' || f.location_id;

INSERT INTO items (id, menu_id, item_name, description, price)
SELECT id, menu_id, item_name, description, price
FROM menu_items;

-- ---------------------------------------------------------------------------
-- 5. Migrate the free-text `ingredients` columns into ingredient tags. Each
--    item's comma-separated string is split into parts (recursive CTE), trimmed
--    and lower-cased; each distinct part becomes a tag with id 'ing:<name>', and
--    a non-optional item_tags link. Only `food` ever carried ingredients in
--    practice, but `menu_items` is handled the same way for completeness.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO tags (id, name, tag_type)
WITH RECURSIVE split(item_id, rest, part) AS (
	SELECT id, ingredients || ',', ''
	FROM food
	WHERE ingredients IS NOT NULL AND TRIM(ingredients) <> ''
	UNION ALL
	SELECT id, ingredients || ',', ''
	FROM menu_items
	WHERE ingredients IS NOT NULL AND TRIM(ingredients) <> ''
	UNION ALL
	SELECT item_id, substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
	FROM split
	WHERE rest <> ''
)
SELECT DISTINCT 'ing:' || LOWER(TRIM(part)), LOWER(TRIM(part)), 'ingredient'
FROM split
WHERE TRIM(part) <> '';

INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
WITH RECURSIVE split(item_id, rest, part) AS (
	SELECT id, ingredients || ',', ''
	FROM food
	WHERE ingredients IS NOT NULL AND TRIM(ingredients) <> ''
	UNION ALL
	SELECT id, ingredients || ',', ''
	FROM menu_items
	WHERE ingredients IS NOT NULL AND TRIM(ingredients) <> ''
	UNION ALL
	SELECT item_id, substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
	FROM split
	WHERE rest <> ''
)
SELECT DISTINCT item_id, 'ing:' || LOWER(TRIM(part)), 0
FROM split
WHERE TRIM(part) <> '';

-- ---------------------------------------------------------------------------
-- 6. Re-point the existing dietary/course tag links and the source links at the
--    unified tables. Item ids were preserved in step 4, so the joins are direct.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
SELECT food_id, tag_id, 0 FROM food_tags
UNION ALL
SELECT menu_item_id, tag_id, 0 FROM menu_item_tags;

INSERT OR IGNORE INTO item_sources (item_id, url, label)
SELECT food_id, url, label FROM food_sources
UNION ALL
SELECT menu_item_id, url, label FROM menu_item_sources;

-- ---------------------------------------------------------------------------
-- 7. Rebuild location_item_overrides so its item reference points at `items`
--    instead of the soon-to-be-dropped `menu_items` (SQLite can't re-target a
--    foreign key in place). The column is renamed menu_item_id -> item_id.
-- ---------------------------------------------------------------------------
CREATE TABLE location_item_overrides_new (
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	available INTEGER,
	price REAL,
	PRIMARY KEY (location_id, item_id)
);

INSERT INTO location_item_overrides_new (location_id, item_id, available, price)
SELECT location_id, menu_item_id, available, price FROM location_item_overrides;

DROP TABLE location_item_overrides;
ALTER TABLE location_item_overrides_new RENAME TO location_item_overrides;

CREATE INDEX IF NOT EXISTS idx_location_item_overrides_item_id
	ON location_item_overrides (item_id);

-- ---------------------------------------------------------------------------
-- 8. Drop the old tables (children before parents). Their data now lives in
--    items / item_tags / item_sources.
-- ---------------------------------------------------------------------------
DROP TABLE food_tags;
DROP TABLE food_sources;
DROP TABLE food;
DROP TABLE menu_item_tags;
DROP TABLE menu_item_sources;
DROP TABLE menu_items;
