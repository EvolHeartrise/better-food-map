-- Migration 0013: a signed-in user's personal dietary profile.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- The profile is the set of dietary restrictions and allergies a user keeps so the
-- map can PRE-APPLY them as default search filters (see src/lib/profile.remote.ts,
-- which resolves a profile to include/exclude tags via resolveDietProfileFilters).
-- Like the rest of migration 0007's user data, every row here is written by the
-- DEPLOYED app at runtime through its `platform.env.DB` binding; the MCP server
-- never touches it. Timestamps are INTEGER Unix milliseconds supplied explicitly by
-- the app, so the column carries no DEFAULT (matching the 0007 convention).
--
-- One row per user (PK = user_id), upserted on save. The selections are stored as
-- two JSON arrays of stable catalog KEYS — the vocabulary that maps a key to its
-- filter tags lives in code (src/lib/diet-profile.ts), not the database — so the
-- mapping can evolve (add an allergen, broaden an ingredient list) without a
-- migration, and a key dropped from the catalog is simply ignored on read. We store
-- keys rather than resolved tag ids so the profile keeps meaning even as the
-- ingredient vocabulary it resolves against changes.
CREATE TABLE IF NOT EXISTS user_dietary_profile (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	-- JSON array of lifestyle restriction keys, e.g. ["vegan","halal"].
	restrictions TEXT NOT NULL DEFAULT '[]',
	-- JSON array of allergen keys, e.g. ["nuts","dairy"].
	allergies TEXT NOT NULL DEFAULT '[]',
	updated_at INTEGER NOT NULL
);
