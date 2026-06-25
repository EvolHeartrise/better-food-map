-- Migration 0007: user accounts, sessions, likes and search history.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Adds the first USER-OWNED data to the map. Sign-in is Google OAuth only (see
-- src/lib/server/oauth.ts and the /auth routes); there are no passwords, so there
-- are no credential columns. Unlike the curated map data — which the MCP/REST
-- tooling writes — every table here is written by the DEPLOYED app at runtime
-- through its `platform.env.DB` binding; the MCP server never touches them.
--
-- Timestamps are INTEGER Unix milliseconds (what `Date.now()` returns in the
-- Worker). The app always supplies them explicitly, so the columns carry no
-- DEFAULT — keeping the schema free of any reliance on a SQLite time function.

-- A signed-in person. `id` is an app-minted UUID; the identity from a provider
-- lives in `oauth_accounts`, so a user can gain more providers later with no
-- schema change. Profile fields mirror the Google ID-token claims and are
-- refreshed on each sign-in; all are nullable since a claim may be absent.
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT,
	email_verified INTEGER NOT NULL DEFAULT 0,
	name TEXT,
	picture TEXT,
	created_at INTEGER NOT NULL
);

-- A provider identity linked to a user. (provider, provider_user_id) is the
-- natural key looked up on every sign-in ("the Google account with sub=…"); a
-- user has at most one row per provider. Only 'google' is written today.
CREATE TABLE IF NOT EXISTS oauth_accounts (
	provider TEXT NOT NULL,
	provider_user_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts (user_id);

-- An active login. `id` is the SHA-256 (hex) of the opaque session token held in
-- the user's cookie — the raw token is NEVER stored, so a database leak cannot be
-- replayed as a live session. `expires_at` is enforced (and slid forward on use)
-- by the app; see src/lib/server/auth.ts.
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

-- Liked locations. The composite PK makes a like idempotent (one per user per
-- location) and is the lookup index; the secondary index supports "who liked this
-- location". Both FKs cascade, so deleting a user or a location cleans these up.
CREATE TABLE IF NOT EXISTS liked_locations (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_liked_locations_location_id ON liked_locations (location_id);

-- Liked menu items. Same shape, keyed to items(id). A separate table (rather than
-- one polymorphic table) lets D1 enforce the FK and cascade to items.
CREATE TABLE IF NOT EXISTS liked_items (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_liked_items_item_id ON liked_items (item_id);

-- Search/filter history, auto-logged for each search a signed-in user runs.
-- Deliberately UNCAPPED for now — we'll add a retention/rollup policy once real
-- volume can be measured. The tag filters are stored as self-contained JSON
-- ([{id,name,tag_type}, …]) so re-applying a past search rehydrates the tag
-- pickers with no extra lookup. `place`/`item` are the free-text filters.
CREATE TABLE IF NOT EXISTS search_history (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	place TEXT NOT NULL DEFAULT '',
	item TEXT NOT NULL DEFAULT '',
	included_tags TEXT NOT NULL DEFAULT '[]',
	excluded_tags TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_created
	ON search_history (user_id, created_at DESC);
