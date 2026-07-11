-- Migration 0028: durable source identity on `locations` (issue #302).
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- `osm_id` is the OpenStreetMap element a location was imported from (e.g.
-- "node/42"), stamped by create_locations / import_chain when a candidate is
-- imported via its staging-store `osm_id`. Until now a row's only link back to
-- its source POI was float-exact coordinate equality — sound while coordinates
-- import verbatim and never move, but fragile under any source shift: a node
-- OSM moves (or a future re-extract that adjusts a point) silently severs the
-- row from its POI. A stored id keeps the identity join exact regardless of
-- where the node sits today, and is the key the upcoming Overture
-- closure-signal joins will match on.
--
-- Identity only: coordinates/addresses keep their OSM-verbatim semantics and
-- the coordinate-exact dedup is unchanged — this column records provenance, it
-- does not replace the invariant.
--
-- NULL for rows that predate this migration (until scripts/backfill-osm-id.ts
-- re-joins them to the staging store) and for the rare venue added with manual
-- coordinates because it has no OSM POI.
--
-- Additive + nullable, so it is backward compatible: the live Worker keeps
-- working until the writing code ships. No table rebuild — `locations` is a
-- parent of ON DELETE CASCADE children (see 0015's note on why a rebuild would
-- wipe likes).

ALTER TABLE locations ADD COLUMN osm_id TEXT;

-- Lookups are always for a concrete id (dedup by source identity, Overture
-- joins); partial index skips the NULL rows the way idx_locations_closed_at
-- (0015) skips open ones.
CREATE INDEX IF NOT EXISTS idx_locations_osm_id ON locations (osm_id) WHERE osm_id IS NOT NULL;
