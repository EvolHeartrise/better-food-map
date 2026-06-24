-- Migration 0005: make a non-empty `address` mandatory on every location.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Every location now has an address (sourced from its OpenStreetMap POI / building,
-- or from Overture Maps where OSM lacks one — see scripts/osm/find-missing-address.ts
-- and scripts/overture-enrich.ts), so we enforce that going forward.
--
-- WHY TRIGGERS, not `address TEXT NOT NULL` / a CHECK constraint: SQLite cannot add
-- a column constraint in place — it requires rebuilding the table (CREATE new, copy,
-- DROP old, RENAME). But `locations` is a PARENT table: `location_sources` and
-- `location_item_overrides` hold `ON DELETE CASCADE` foreign keys to it. With foreign
-- keys enabled (D1's default), DROP TABLE performs an implicit DELETE of every row,
-- which would CASCADE and wipe those child rows. Two BEFORE triggers enforce the same
-- invariant at write time without that hazard, and `IF NOT EXISTS` keeps this
-- migration idempotent. The MCP create_locations tool validates address up front too
-- (this is the database-level backstop).

CREATE TRIGGER IF NOT EXISTS locations_require_address_insert
BEFORE INSERT ON locations
FOR EACH ROW WHEN NEW.address IS NULL OR TRIM(NEW.address) = ''
BEGIN
	SELECT RAISE(ABORT, 'locations.address is required and must be non-empty');
END;

CREATE TRIGGER IF NOT EXISTS locations_require_address_update
BEFORE UPDATE OF address ON locations
FOR EACH ROW WHEN NEW.address IS NULL OR TRIM(NEW.address) = ''
BEGIN
	SELECT RAISE(ABORT, 'locations.address is required and must be non-empty');
END;
