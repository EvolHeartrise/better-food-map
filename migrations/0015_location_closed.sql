-- Migration 0015: soft-delete ("permanently closed") support on `locations`.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- A venue that has permanently closed should disappear from the map but must NOT be
-- hard-deleted: `liked_locations.location_id` references `locations(id) ON DELETE
-- CASCADE` (migration 0007), so a DELETE would destroy the users' likes we want to
-- keep for analysis. Instead we soft-delete: mark the row closed and filter it out of
-- every display/browse read (queryMapData, gridRepresentativeIds, getStats,
-- list_locations, get_location). The row stays, so its likes, menu and sources are
-- preserved, and — because the create-dedup (existingLocationsAtCoords) and search_poi
-- (existingInBbox) reads are deliberately NOT filtered — a closed location still blocks
-- both re-creation and re-suggestion, so it never wastes an agent's research time again.
--
-- `closed_at` is a Unix-epoch-milliseconds timestamp (matching the codebase's INTEGER
-- time convention, e.g. liked_locations.created_at in 0007); NULL means open/live.
-- `closed_reason` is a short human note with the closure evidence (NULL when open).
--
-- Additive + nullable, so it is backward compatible: the live Worker keeps working
-- until the reading code ships. No table rebuild — `locations` is a PARENT of
-- `ON DELETE CASCADE` children (location_sources, location_item_overrides,
-- liked_locations), so a create-new/copy/drop rebuild's implicit DELETE would cascade
-- and wipe exactly the likes this migration exists to preserve (see 0009's WHY-TRIGGERS
-- note). A nullable soft-delete flag needs no constraint, so no trigger is required.

ALTER TABLE locations ADD COLUMN closed_at INTEGER;
ALTER TABLE locations ADD COLUMN closed_reason TEXT;

-- Only closed rows carry a timestamp; partial index keeps the closed-set scannable for
-- analysis without weighing on the overwhelmingly-open table.
CREATE INDEX IF NOT EXISTS idx_locations_closed_at ON locations (closed_at) WHERE closed_at IS NOT NULL;
