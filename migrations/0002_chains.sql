-- Migration 0002: chains / brands / shared menus.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Adds the chain model alongside the existing per-location `food` table (which
-- is left untouched). A location is now either:
--   * INDEPENDENT — its menu lives in `food` (food.location_id), as before; or
--   * a CHAIN location — it sets `locations.menu_id`, and serves the shared
--     items of that brand menu (`menu_items`), define-once / reference-many.
-- Per-location differences from a shared menu (a sold-out item, regional price)
-- live in `location_item_overrides`, so the shared menu stays the single source
-- of truth and only the deltas are stored.

CREATE TABLE IF NOT EXISTS brands (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	website TEXT,
	logo_url TEXT
);

-- A menu is a regionally-scoped set of items shared across a brand's locations
-- (e.g. "Subway UK"). `region` is a free-form scope label (e.g. "GB", "US-CA",
-- "Canada"); `last_verified` is an ISO date, since chain menus go stale.
CREATE TABLE IF NOT EXISTS menus (
	id TEXT PRIMARY KEY,
	brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	region TEXT,
	last_verified TEXT
);

CREATE INDEX IF NOT EXISTS idx_menus_brand_id ON menus (brand_id);

-- Canonical items of a menu. Defined once per menu, not per location. `price`
-- is the default; a location can override it via location_item_overrides.
CREATE TABLE IF NOT EXISTS menu_items (
	id TEXT PRIMARY KEY,
	menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
	item_name TEXT NOT NULL,
	description TEXT,
	ingredients TEXT,
	price REAL
);

CREATE INDEX IF NOT EXISTS idx_menu_items_menu_id ON menu_items (menu_id);

-- Dietary/course tags per menu item (mirrors food_tags for the chain side).
CREATE TABLE IF NOT EXISTS menu_item_tags (
	menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (menu_item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_tags_tag_id ON menu_item_tags (tag_id);

-- Provenance per menu item (mirrors food_sources).
CREATE TABLE IF NOT EXISTS menu_item_sources (
	menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	label TEXT,
	PRIMARY KEY (menu_item_id, url)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_sources_menu_item_id ON menu_item_sources (menu_item_id);

-- Menu-level provenance: cite the official menu once for the whole chain,
-- instead of repeating the same URL on every location's every item.
CREATE TABLE IF NOT EXISTS menu_sources (
	menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	label TEXT,
	PRIMARY KEY (menu_id, url)
);

CREATE INDEX IF NOT EXISTS idx_menu_sources_menu_id ON menu_sources (menu_id);

-- Per-location deviations from a shared menu. A row exists only where a location
-- differs from its menu's default, so this table stays small.
--   available: 0 = not served at this location (NULL = inherit / served)
--   price:     overrides the menu item's price here (NULL = inherit)
CREATE TABLE IF NOT EXISTS location_item_overrides (
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
	available INTEGER,
	price REAL,
	PRIMARY KEY (location_id, menu_item_id)
);

CREATE INDEX IF NOT EXISTS idx_location_item_overrides_menu_item_id ON location_item_overrides (menu_item_id);

-- Link locations to a brand and its shared menu. Both nullable: an independent
-- venue leaves them NULL. ON DELETE SET NULL means deleting a brand/menu reverts
-- its locations to independent rather than failing or dangling.
ALTER TABLE locations ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE locations ADD COLUMN menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_locations_brand_id ON locations (brand_id);
CREATE INDEX IF NOT EXISTS idx_locations_menu_id ON locations (menu_id);
