-- Migration 0008: structured address columns on `locations`.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- The single freeform `address` column was filled inconsistently across ingestion
-- pipelines (street-only chains, full independents, mixed `St`/`Street`,
-- `ON`/`Ontario`, spaced/unspaced postcodes, trailing country, embedded notes).
-- We move to structured parts so the data stays uniform and the display line can
-- be composed canonically (see src/lib/address.ts formatAddress).
--
-- This migration only ADDS the columns (all nullable) so it is additive and
-- backward compatible: the live Worker keeps reading `address` until the code
-- switch ships. A one-time backfill (scripts/backfill-address-parts.ts) then
-- populates these from each location's OSM data, and migration 0009 enforces the
-- required parts and drops `address`.
--
-- `region` is a 2-letter province/state code, `country` an ISO-3166-1 alpha-2
-- code; `postcode` may stay NULL where no full code could be resolved.

ALTER TABLE locations ADD COLUMN street TEXT;
ALTER TABLE locations ADD COLUMN city TEXT;
ALTER TABLE locations ADD COLUMN region TEXT;
ALTER TABLE locations ADD COLUMN postcode TEXT;
ALTER TABLE locations ADD COLUMN country TEXT;
