-- Initial schema for the food-map database on Cloudflare D1.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
-- D1 enforces foreign keys, so ON DELETE CASCADE is honoured.

CREATE TABLE IF NOT EXISTS locations (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	category TEXT,
	latitude REAL NOT NULL,
	longitude REAL NOT NULL,
	address TEXT,
	phone TEXT,
	website TEXT
);

CREATE TABLE IF NOT EXISTS food (
	id TEXT PRIMARY KEY,
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	item_name TEXT NOT NULL,
	description TEXT,
	ingredients TEXT,
	price REAL
);

CREATE INDEX IF NOT EXISTS idx_food_location_id ON food (location_id);

CREATE TABLE IF NOT EXISTS tags (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'dietary'
);

CREATE TABLE IF NOT EXISTS food_tags (
	food_id TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (food_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_food_tags_tag_id ON food_tags (tag_id);

-- Provenance for each menu item: zero or more source URLs (with optional
-- labels). The (food_id, url) primary key de-duplicates the same URL per item.
CREATE TABLE IF NOT EXISTS food_sources (
	food_id TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	label TEXT,
	PRIMARY KEY (food_id, url)
);

CREATE INDEX IF NOT EXISTS idx_food_sources_food_id ON food_sources (food_id);

-- Provenance for each location, same shape as food_sources.
CREATE TABLE IF NOT EXISTS location_sources (
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	label TEXT,
	PRIMARY KEY (location_id, url)
);

CREATE INDEX IF NOT EXISTS idx_location_sources_location_id ON location_sources (location_id);

-- Canonical, app-defined tags (mirrors TAGS in src/lib/server/db.ts). These are
-- part of the app contract, not user data, so they are seeded by the migration.
INSERT INTO tags (id, label, kind) VALUES
	('vegan', 'Vegan', 'dietary'),
	('vegetarian', 'Vegetarian', 'dietary'),
	('gluten_free', 'Gluten-free', 'dietary'),
	('dairy_free', 'Dairy-free', 'dietary'),
	('nut_free', 'Nut-free', 'dietary'),
	('halal', 'Halal', 'dietary'),
	('dessert', 'Dessert', 'course'),
	('drink', 'Drink', 'course')
ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind;
