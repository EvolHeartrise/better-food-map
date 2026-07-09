-- Migration 0020: key FTS mirror maintenance by rowid instead of the
-- UNINDEXED id (issue #91).
--
-- WHY: the 0016 triggers kept locations_fts/items_fts in lockstep with
-- `UPDATE/DELETE … WHERE id = old.id`. `id` is UNINDEXED in both mirrors, and
-- FTS5's xBestIndex offers no pushdown of any kind for an UNINDEXED column, so
-- every UPDATE/DELETE trigger firing scanned the ENTIRE mirror ("SCAN …
-- VIRTUAL TABLE INDEX 0:" under EXPLAIN QUERY PLAN). Bulk rewrites go
-- quadratic: deleting a 300-item chain menu cascades 300 item deletes, each
-- scanning all of items_fts — O(rows × mirror) rows_read, which is real D1
-- cost today and a statement-timeout risk as items grows.
--
-- FIX: a tiny ordinary map table per mirror — base-table id → the mirror's own
-- rowid — so each trigger becomes two indexed point lookups. 0016 avoided
-- rowid-joining the BASE tables because their implicit rowids aren't stable
-- (TEXT UUID primary keys; VACUUM may renumber). The map instead stores the
-- FTS table's OWN rowid, which IS stable: an FTS5 table's rowid is an explicit
-- INTEGER PRIMARY KEY column in its shadow storage, never renumbered.
--   • fts_rowid INTEGER PRIMARY KEY: the mirror row's rowid. On insert we let
--     SQLite auto-assign it (max+1, exactly what FTS5 itself would pick) and
--     write the FTS row WITH that explicit rowid, so the two can't drift.
--   • id TEXT UNIQUE: the base-table id, giving the trigger's `WHERE id =
--     old.id` lookup a covering index.
--
-- The insert path changes shape (map row first, then the FTS row at the
-- mapped rowid) but not cost; update/delete drop from a full mirror scan to
-- "SCAN … VIRTUAL TABLE INDEX 0:=" — FTS5's rowid-equality plan — plus an
-- indexed map lookup. Search itself (LIKE over the name column) is untouched.
--
-- Note for tooling: scripts/db-pull.ts must keep these map tables' CREATEs
-- (they are ordinary tables, not FTS5 shadow tables, despite the name prefix)
-- while skipping their data export — replaying base-table rows re-fires the
-- insert triggers, rebuilding map and mirror together.
--
-- Idempotent: CREATE IF NOT EXISTS, guarded backfills, and DROP-then-CREATE
-- for the triggers, so re-applying is a no-op.

CREATE TABLE IF NOT EXISTS locations_fts_map (
	fts_rowid INTEGER PRIMARY KEY,
	id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items_fts_map (
	fts_rowid INTEGER PRIMARY KEY,
	id TEXT NOT NULL UNIQUE
);

-- Backfill from the mirrors' current rowids (one full mirror scan, once).
-- Guarded so a re-run inserts nothing.
INSERT INTO locations_fts_map (fts_rowid, id)
SELECT rowid, id FROM locations_fts
WHERE rowid NOT IN (SELECT fts_rowid FROM locations_fts_map);

INSERT INTO items_fts_map (fts_rowid, id)
SELECT rowid, id FROM items_fts
WHERE rowid NOT IN (SELECT fts_rowid FROM items_fts_map);

-- Recreate the 0016 triggers keyed by rowid. Everything 0016 established still
-- holds: UPDATE OF so non-name writes never pay the FTS write, the delete
-- trigger covering the menu/location→items cascade, and the mirrors knowing
-- nothing about closed_at or menu membership.

DROP TRIGGER IF EXISTS locations_fts_ai;
CREATE TRIGGER locations_fts_ai AFTER INSERT ON locations BEGIN
	INSERT INTO locations_fts_map (id) VALUES (new.id);
	INSERT INTO locations_fts (rowid, id, name)
	VALUES ((SELECT fts_rowid FROM locations_fts_map WHERE id = new.id), new.id, new.name);
END;

DROP TRIGGER IF EXISTS locations_fts_au;
CREATE TRIGGER locations_fts_au AFTER UPDATE OF id, name ON locations BEGIN
	UPDATE locations_fts SET id = new.id, name = new.name
	WHERE rowid = (SELECT fts_rowid FROM locations_fts_map WHERE id = old.id);
	UPDATE locations_fts_map SET id = new.id WHERE id = old.id;
END;

DROP TRIGGER IF EXISTS locations_fts_ad;
CREATE TRIGGER locations_fts_ad AFTER DELETE ON locations BEGIN
	DELETE FROM locations_fts
	WHERE rowid = (SELECT fts_rowid FROM locations_fts_map WHERE id = old.id);
	DELETE FROM locations_fts_map WHERE id = old.id;
END;

DROP TRIGGER IF EXISTS items_fts_ai;
CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
	INSERT INTO items_fts_map (id) VALUES (new.id);
	INSERT INTO items_fts (rowid, id, item_name)
	VALUES ((SELECT fts_rowid FROM items_fts_map WHERE id = new.id), new.id, new.item_name);
END;

DROP TRIGGER IF EXISTS items_fts_au;
CREATE TRIGGER items_fts_au AFTER UPDATE OF id, item_name ON items BEGIN
	UPDATE items_fts SET id = new.id, item_name = new.item_name
	WHERE rowid = (SELECT fts_rowid FROM items_fts_map WHERE id = old.id);
	UPDATE items_fts_map SET id = new.id WHERE id = old.id;
END;

DROP TRIGGER IF EXISTS items_fts_ad;
CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
	DELETE FROM items_fts
	WHERE rowid = (SELECT fts_rowid FROM items_fts_map WHERE id = old.id);
	DELETE FROM items_fts_map WHERE id = old.id;
END;
