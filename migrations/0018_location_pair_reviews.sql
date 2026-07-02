-- Migration 0018: persisted duplicate-audit verdicts.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- audit_locations (check: "duplicate_locations") flags same-name/same-brand
-- pairs within a small radius. Some flagged pairs are then VERIFIED to be two
-- real venues (mall unit + street level, airport concourses, dense downtown
-- blocks). Without a durable record of that verdict, every future audit
-- re-flags the same pairs and the verification work (store-locator checks) is
-- paid again. One row here = "these two locations were verified as distinct
-- venues"; the duplicate audit suppresses the pair and counts it in
-- `suppressed_reviewed`. Recorded via the mark_not_duplicate MCP tool.
--
-- The pair is stored ORDERED (location_id_a < location_id_b) so an unordered
-- pair has exactly one row. Rows cascade away with either location: if a half
-- is later deleted (e.g. it was a duplicate after all), the verdict goes too.

CREATE TABLE IF NOT EXISTS location_pair_reviews (
	location_id_a TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	location_id_b TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
	verdict TEXT NOT NULL CHECK (verdict IN ('distinct')),
	reason TEXT NOT NULL,
	reviewed_at TEXT NOT NULL,
	PRIMARY KEY (location_id_a, location_id_b),
	CHECK (location_id_a < location_id_b)
);

CREATE INDEX IF NOT EXISTS idx_location_pair_reviews_b ON location_pair_reviews (location_id_b);
