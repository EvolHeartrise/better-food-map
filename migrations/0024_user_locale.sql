-- Migration 0024: a signed-in user's saved UI locale (i18n phase 4).
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
-- D1 migrations are MANUAL — CI deploys the Worker but never runs them, so this
-- must be applied by hand at deploy time (bun run d1:migrate).
--
-- Phase 1 of the localization effort resolves each request's locale from the
-- Accept-Language header and stores nothing. Phase 4 adds an EXPLICIT override the
-- user can save. On the device where they pick, the choice also rides a
-- consent-exempt preference cookie (set only on an active pick); this table is the
-- DURABLE, cross-device copy for a signed-in user — read on the request path by
-- folding it into the session lookup (getSessionWithUser LEFT JOINs it), so it
-- costs no extra D1 round trip.
--
-- A DEDICATED table rather than a `locale` column on user_dietary_profile, so the
-- two preferences stay fully decoupled: a user who saves only a locale (never a
-- diet) — or only a diet — gets exactly one row in the relevant table with its own
-- accurate updated_at, and neither setter can clobber the other's value or share a
-- muddled timestamp. It mirrors migration 0013's shape exactly: one row per user
-- (PK = user_id, cascading with the user), written only by the DEPLOYED app at
-- runtime through platform.env.DB (the MCP server never touches it), with an
-- INTEGER Unix-millisecond updated_at supplied explicitly by the app — no DEFAULT,
-- per the 0007 convention.
--
-- The stored value is validated to a supported locale tag in code before write and
-- again on read (isLocale, src/lib/paraglide/runtime), mirroring how the dietary
-- profile's value is sanitized in code (migration 0014): a value no longer in the
-- supported set simply reads as "no saved locale" and the request falls through to
-- Accept-Language. NOT NULL because a row exists only once a locale is saved (the
-- picker always sets a supported locale; there is no "cleared" state).
CREATE TABLE IF NOT EXISTS user_locale (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	-- A supported UI locale tag, e.g. 'en' or 'fr' (see `locales` in
	-- src/lib/paraglide/runtime.js).
	locale TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
