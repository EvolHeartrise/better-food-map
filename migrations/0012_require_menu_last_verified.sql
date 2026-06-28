-- Migration 0012: require menus.last_verified — every menu carries a verification date.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Backfills existing NULLs to the apply date, then enforces non-null on every
-- future write. The map shows a per-menu freshness signal, and we now guarantee
-- there is always a date to show (no "unverified" state).
--
-- WHY TRIGGERS, not a NOT NULL column (same reasoning as migrations 0005 / 0009):
-- SQLite cannot add a column constraint in place — it requires rebuilding the
-- table — and `menus` is a PARENT of ON DELETE CASCADE children (items,
-- menu_sources, and locations.menu_id), so a rebuild's implicit DELETE would
-- cascade and wipe them. BEFORE-write triggers enforce the invariant without that
-- hazard.
--
-- ORDERING (same as 0009): apply this AFTER the app/MCP code that supplies a date
-- on menu insert (currentVerificationDate in src/lib/server/db.ts) has shipped —
-- otherwise the still-deployed Worker, which inserts private menus with
-- last_verified NULL, would start aborting on every create_locations/create_foods.

-- 1. Backfill: a menu with no date is treated as verified as of the apply date.
UPDATE menus SET last_verified = date('now')
WHERE last_verified IS NULL OR TRIM(last_verified) = '';

-- 2. Enforce: reject any insert/update that would leave last_verified empty.
CREATE TRIGGER IF NOT EXISTS menus_require_last_verified_insert
BEFORE INSERT ON menus
FOR EACH ROW WHEN NEW.last_verified IS NULL OR TRIM(NEW.last_verified) = ''
BEGIN
	SELECT RAISE(ABORT, 'menus require a non-empty last_verified date');
END;

CREATE TRIGGER IF NOT EXISTS menus_require_last_verified_update
BEFORE UPDATE OF last_verified ON menus
FOR EACH ROW WHEN NEW.last_verified IS NULL OR TRIM(NEW.last_verified) = ''
BEGIN
	SELECT RAISE(ABORT, 'menus require a non-empty last_verified date');
END;
