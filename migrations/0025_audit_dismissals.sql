-- Migration 0025: generic audit-finding dismissals.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- audit_locations surfaces work-lists, but some findings are verified to be
-- NOT a problem (two real venues near each other, a venue OSM renamed only
-- cosmetically, a POI the staging store simply lacks). Without a durable
-- record of that verdict every future audit re-flags the same finding and the
-- verification work is paid again. One row here = "this finding was reviewed
-- and dismissed"; every audit check suppresses matching findings by default
-- (counted in `suppressed_dismissed`) and re-surfaces them under
-- `include_dismissed: true`. Recorded via the dismiss_audit_finding MCP tool.
--
-- `subject_key` identifies WHAT was flagged (a location id, an item id, a
-- "kind:id[:field]" ref for html_entities, or an ordered "idA|idB" pair for
-- duplicate_locations). `fingerprint` pins the EVIDENCE the dismissal judged
-- (e.g. "renamed:<normalized occupant name>"): when the audit later computes a
-- different fingerprint for the same subject, the finding is materially new
-- and flags again. One dismissal per (check, subject); re-dismissing replaces
-- the fingerprint/reason/date.
--
-- Subjects are NOT foreign keys (they span four tables and pair composites),
-- so rows for deleted subjects are not cascaded away — they are inert (the
-- audit never computes their key again) and harmless.
--
-- Supersedes location_pair_reviews (migration 0018), whose rows move over as
-- duplicate_locations dismissals: the pair itself is the evidence, so their
-- fingerprint is the empty string.

CREATE TABLE IF NOT EXISTS audit_dismissals (
	check_name TEXT NOT NULL,
	subject_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	reason TEXT NOT NULL,
	dismissed_at TEXT NOT NULL,
	PRIMARY KEY (check_name, subject_key)
);

-- OR IGNORE keeps the file re-runnable if a partial apply ever committed the
-- copy without the DROP below.
INSERT OR IGNORE INTO audit_dismissals (check_name, subject_key, fingerprint, reason, dismissed_at)
	SELECT 'duplicate_locations', location_id_a || '|' || location_id_b, '', reason, reviewed_at
	FROM location_pair_reviews;

DROP TABLE location_pair_reviews;
