-- Migration 0016: FTS5 trigram search index over venue and item names.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- WHY: the global menu search (getSearchMapData, src/lib/server/db.ts) matches its
-- free-text term by SUBSTRING — `name LIKE '%q%'` over every venue name and every
-- item name. A B-tree index cannot accelerate a leading-wildcard LIKE, so each
-- search walked both tables end to end. Fine at today's scale, but the coverage
-- roadmap is Canada → US → beyond, and `items` grows with every menu ingested.
-- Same fix as the old tags_fts (migration 0006, dropped in 0014 along with the
-- ingredient vocabulary it indexed): FTS5 tables with the `trigram` tokenizer,
-- which accelerate a plain `LIKE '%q%'` for patterns containing a run of 3+
-- characters, while SHORTER patterns fall back to a scan of the FTS table and
-- stay correct. Querying with LIKE (never MATCH) keeps the search's substring
-- semantics — which the client mirrors via `.includes()` in +page.svelte —
-- literally identical, for every query length.
--
-- IMPORTANT (the lesson recorded on 0006): an ESCAPE clause on the LIKE disables
-- the trigram pushdown — SQLite only forwards two-argument LIKEs to a virtual
-- table, and LIKE+ESCAPE is the three-argument form — forcing a full scan of the
-- FTS table. getSearchMapData therefore appends `ESCAPE '\'` ONLY when the query
-- actually contains a `%`/`_`/`\` that must match literally; when nothing needed
-- escaping the pattern carries no escape character, so the two forms are
-- semantically identical and the common path keeps the index.
--
-- SHAPE: standalone (contentful) FTS tables — the searched name plus an
-- UNINDEXED id (a UUID needs no trigram index), kept in lockstep with the base
-- table by AFTER INSERT/UPDATE/DELETE triggers. Not external-content, and not
-- rowid-mirrored like 0006 did for tags: locations/items have TEXT UUID primary
-- keys, so their implicit rowids are NOT stable (a rowid that isn't an INTEGER
-- PRIMARY KEY may be renumbered by VACUUM), which would silently desync the
-- index. Joining back by id keeps the base table the source of truth:
--
--   • locations_fts (id, name): deliberately knows NOTHING about closed_at —
--     a soft-deleted venue (migration 0015) keeps its row here; the outer query
--     already filters `closed_at IS NULL`, so closing/reopening needs no sync.
--   • items_fts (id, item_name): deliberately carries NO menu_id — the search
--     joins items_fts.id back to `items` for menu membership, so moving an item
--     between menus (update_items.menu_id) needs no sync, and a stale FTS row
--     can never produce a false match on its own.
--
-- The update triggers fire only on writes that SET the name column (UPDATE OF),
-- so the frequent non-name updates — coordinate/address audits, closed_at flips,
-- price changes — never pay the FTS write. `id` is included in the OF list as
-- insurance; nothing rewrites ids today.
--
-- ADDITIVE and backward-compatible: nothing existing is altered and the live
-- Worker never touches these tables, so this migration must be applied to
-- production BEFORE the code that reads it deploys (the reverse order breaks
-- search with "no such table"). Note for tooling: `wrangler d1 export` refuses a
-- database containing an FTS5 virtual table; scripts/db-pull.ts already exports
-- schema and per-table data separately and skips virtual/shadow tables, and its
-- data replay re-fires the triggers below, rebuilding the local index.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout, and the backfills only insert
-- rows not already mirrored, so re-applying this migration is a no-op.

CREATE VIRTUAL TABLE IF NOT EXISTS locations_fts USING fts5(
	id UNINDEXED,
	name,
	tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
	id UNINDEXED,
	item_name,
	tokenize = 'trigram'
);

-- Backfill from the existing rows (closed venues included — see the shape note).
-- Guarded so a re-run inserts nothing.
INSERT INTO locations_fts (id, name)
SELECT id, name FROM locations
WHERE id NOT IN (SELECT id FROM locations_fts);

INSERT INTO items_fts (id, item_name)
SELECT id, item_name FROM items
WHERE id NOT IN (SELECT id FROM items_fts);

-- Keep locations_fts in lockstep with locations.
CREATE TRIGGER IF NOT EXISTS locations_fts_ai AFTER INSERT ON locations BEGIN
	INSERT INTO locations_fts (id, name) VALUES (new.id, new.name);
END;

CREATE TRIGGER IF NOT EXISTS locations_fts_au AFTER UPDATE OF id, name ON locations BEGIN
	UPDATE locations_fts SET id = new.id, name = new.name WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS locations_fts_ad AFTER DELETE ON locations BEGIN
	DELETE FROM locations_fts WHERE id = old.id;
END;

-- Keep items_fts in lockstep with items. The delete trigger also covers the
-- cascade path (deleting a menu/location cascades onto items; foreign-key
-- actions fire AFTER DELETE triggers on the child table).
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
	INSERT INTO items_fts (id, item_name) VALUES (new.id, new.item_name);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF id, item_name ON items BEGIN
	UPDATE items_fts SET id = new.id, item_name = new.item_name WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
	DELETE FROM items_fts WHERE id = old.id;
END;
