-- Migration 0009: enforce the required structured address parts and drop the old
-- freeform `address` column. Applied AFTER the backfill has populated the new
-- columns (scripts/backfill-address-parts.ts) AND the new app/MCP code that reads
-- the structured parts and derives the display line has shipped — otherwise the
-- still-deployed Worker, which SELECTs `address`, would break.
--
-- Order matters: drop the migration-0005 address triggers BEFORE dropping the
-- column they reference, add the new required-part triggers, then drop `address`.
--
-- WHY TRIGGERS (same reasoning as 0005): SQLite cannot add a column constraint in
-- place — it requires rebuilding the table — and `locations` is a PARENT of
-- `ON DELETE CASCADE` children, so a rebuild's implicit DELETE would cascade and
-- wipe them. BEFORE-write triggers enforce the invariant without that hazard.
-- `street`, `city`, `region`, `country` are required; `postcode` may be NULL.

DROP TRIGGER IF EXISTS locations_require_address_insert;
DROP TRIGGER IF EXISTS locations_require_address_update;

CREATE TRIGGER IF NOT EXISTS locations_require_address_parts_insert
BEFORE INSERT ON locations
FOR EACH ROW WHEN
	NEW.street IS NULL OR TRIM(NEW.street) = ''
	OR NEW.city IS NULL OR TRIM(NEW.city) = ''
	OR NEW.region IS NULL OR TRIM(NEW.region) = ''
	OR NEW.country IS NULL OR TRIM(NEW.country) = ''
BEGIN
	SELECT RAISE(ABORT, 'locations require non-empty street, city, region, and country');
END;

CREATE TRIGGER IF NOT EXISTS locations_require_address_parts_update
BEFORE UPDATE OF street, city, region, country ON locations
FOR EACH ROW WHEN
	NEW.street IS NULL OR TRIM(NEW.street) = ''
	OR NEW.city IS NULL OR TRIM(NEW.city) = ''
	OR NEW.region IS NULL OR TRIM(NEW.region) = ''
	OR NEW.country IS NULL OR TRIM(NEW.country) = ''
BEGIN
	SELECT RAISE(ABORT, 'locations require non-empty street, city, region, and country');
END;

ALTER TABLE locations DROP COLUMN address;
