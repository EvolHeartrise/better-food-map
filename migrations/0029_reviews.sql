-- Migration 0029: user bookmarks, ratings/reviews and review reports.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
-- D1 migrations are MANUAL — CI deploys the Worker but never runs them, so this
-- must be applied by hand at deploy time (bun run d1:migrate). Because it DROPS the
-- old like tables, the migration and the code that reads the new tables must ship
-- together.
--
-- This replaces the single heart/like (migration 0007's liked_locations /
-- liked_items) with three independent user actions on both a venue and a menu item:
--   • BOOKMARK — a private "save / want to try" list. Never shown to anyone else.
--   • RATING (+ optional review text) — 1..5 stars. A bare rating (no text) is an
--     ANONYMOUS aggregate signal only, never attributed; a rating WITH text is a
--     PUBLIC, attributed review (author name/picture from the users row).
--   • REPORT — a reader flags a public review; enough distinct reports auto-hide it.
--
-- Like the rest of migration 0007's user data, every row here is written ONLY by the
-- DEPLOYED app at runtime through its platform.env.DB binding; the MCP/agent tooling
-- never touches it. Timestamps are INTEGER Unix milliseconds supplied explicitly by
-- the app (what Date.now() returns in the Worker), so the columns carry no DEFAULT —
-- keeping the schema free of any reliance on a SQLite time function (the 0007
-- convention). Every table cascades from its user and its target, so deleting a user,
-- a location or an item cleans up the rows that reference it.
--
-- SEPARATE tables per target (location_* / item_*) rather than one polymorphic table:
-- exactly as 0007 split liked_locations from liked_items, this lets D1 enforce the
-- foreign key and cascade to the right parent. There is deliberately no single likes
-- table shared across targets.

-- The single user today has no data worth preserving here, so the old like tables are
-- dropped outright rather than migrated. Nothing else references them (leaf tables).
DROP TABLE IF EXISTS liked_locations;
DROP TABLE IF EXISTS liked_items;

-- ── Bookmarks ──────────────────────────────────────────────────────────────
-- A private saved venue / item. Same shape and role as 0007's liked_locations /
-- liked_items: composite PK makes it idempotent (one per user per target) and is the
-- lookup index; the secondary index supports "who bookmarked this / how many".
CREATE TABLE IF NOT EXISTS location_bookmarks (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_location_bookmarks_location_id ON location_bookmarks (location_id);

CREATE TABLE IF NOT EXISTS item_bookmarks (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_bookmarks_item_id ON item_bookmarks (item_id);

-- ── Reviews (rating + optional text) ─────────────────────────────────────────
-- One row per (user, target): `rating` is always present (1..5); `body` is optional.
-- A synthetic `id` PK gives reports (and, later, review photos) a stable single-column
-- key to reference; UNIQUE(user_id, location_id) is the idempotency/upsert key — a
-- user re-rating a venue updates their one row (INSERT … ON CONFLICT DO UPDATE).
--
-- Display rule: a review is publicly attributed iff body IS NOT NULL AND trim(body)
-- <> '' AND hidden_at IS NULL. A bare rating (empty body) only feeds the anonymous
-- aggregate. hidden_at (Unix ms) is set by moderation — an auto-hide once enough
-- distinct users report it, or a manual admin hide — and excludes the row from BOTH
-- the public list AND the aggregate; hidden_reason is a short note ('auto:reports' or
-- an admin note). updated_at moves on every edit.
-- `admin_cleared` is set once a moderator un-hides a review by hand: it makes that
-- decision DURABLE by exempting the review from the report auto-hide, so a fresh wave
-- of reports (e.g. a harasser's sock-puppets) can't silently re-hide what a human
-- already vindicated. A manual admin hide still works regardless (it sets hidden_at).
CREATE TABLE IF NOT EXISTS location_reviews (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
	body TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	hidden_at INTEGER,
	hidden_reason TEXT,
	admin_cleared INTEGER NOT NULL DEFAULT 0,
	UNIQUE (user_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_location_reviews_location_id ON location_reviews (location_id);
-- Keeps the hidden set (moderation queue) scannable without weighing on the
-- overwhelmingly-visible table.
CREATE INDEX IF NOT EXISTS idx_location_reviews_hidden ON location_reviews (hidden_at) WHERE hidden_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS item_reviews (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
	body TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	hidden_at INTEGER,
	hidden_reason TEXT,
	admin_cleared INTEGER NOT NULL DEFAULT 0,
	UNIQUE (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_reviews_item_id ON item_reviews (item_id);
CREATE INDEX IF NOT EXISTS idx_item_reviews_hidden ON item_reviews (hidden_at) WHERE hidden_at IS NOT NULL;

-- ── Reports ──────────────────────────────────────────────────────────────────
-- A reader flagging a public review. UNIQUE(review_id, reporter_user_id) makes a
-- report idempotent (one per reader per review) and is the count the auto-hide reads.
-- Rows cascade with the review (a deleted review takes its reports) and with the
-- reporter. `reason` is an optional short free-text note.
CREATE TABLE IF NOT EXISTS location_review_reports (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL REFERENCES location_reviews(id) ON DELETE CASCADE,
	reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (review_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_location_review_reports_review ON location_review_reports (review_id);

CREATE TABLE IF NOT EXISTS item_review_reports (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL REFERENCES item_reviews(id) ON DELETE CASCADE,
	reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (review_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_item_review_reports_review ON item_review_reports (review_id);
