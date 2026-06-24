-- Migration 0006: trigram full-text index over tag names.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- The tag filter's searchable picker matches tags by substring (name LIKE
-- '%q%'), and the ingredient vocabulary it searches is already in the thousands
-- of rows and grows with every menu ingested. A B-tree index cannot accelerate a
-- LEADING-wildcard LIKE — SQLite must scan the table regardless — so an index on
-- tags(name) would not help. Instead we add an FTS5 table with the `trigram`
-- tokenizer, which DOES accelerate `name LIKE '%substr%'` for patterns of 3+
-- characters (shorter patterns fall back to a scan and stay correct), and keep it
-- in lockstep with `tags` via triggers.
--
-- IMPORTANT: searchTagVocabulary (src/lib/server/db.ts) must NOT use a LIKE
-- ESCAPE clause against this table — an ESCAPE clause disables the trigram LIKE
-- optimisation and forces a full scan. It sanitises `%`/`_` in the query instead.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout, and the backfill only inserts
-- tags not already mirrored, so re-applying this migration is a no-op.

CREATE VIRTUAL TABLE IF NOT EXISTS tags_fts USING fts5(
	name,
	tokenize = 'trigram'
);

-- Backfill from the existing vocabulary. The FTS rowid mirrors tags.rowid so a
-- match joins straight back to its tag row. Guarded so a re-run inserts nothing.
INSERT INTO tags_fts (rowid, name)
SELECT rowid, name FROM tags
WHERE rowid NOT IN (SELECT rowid FROM tags_fts);

-- Keep tags_fts in lockstep with tags. Ingredient tags are inserted (via
-- INSERT OR IGNORE) as menus are ingested; the curated tags are seeded. Tag rows
-- are effectively never updated or deleted in practice, but the update/delete
-- triggers are included for correctness.
CREATE TRIGGER IF NOT EXISTS tags_fts_ai AFTER INSERT ON tags BEGIN
	INSERT INTO tags_fts (rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS tags_fts_ad AFTER DELETE ON tags BEGIN
	DELETE FROM tags_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS tags_fts_au AFTER UPDATE ON tags BEGIN
	UPDATE tags_fts SET name = new.name WHERE rowid = old.rowid;
END;
