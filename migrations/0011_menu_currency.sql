-- Migration 0011: per-menu currency.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- A menu's item prices were stored as bare numbers documented as CAD, but the
-- model supports regionally-scoped menus (e.g. "Subway UK") whose prices are not
-- CAD. Currency is a property of the MENU (one region → one currency), mirroring
-- how `region`, `last_verified` and menu-level sources are said once per menu
-- rather than repeated on every item. Each item read carries its menu's currency
-- so a price is always self-describing on the wire.
--
-- Additive and backward compatible: the column is NOT NULL with a 'CAD' default,
-- so every existing menu (the Canada-first dataset) keeps its current meaning and
-- the live Worker's price formatting is unchanged until a menu is set otherwise.
-- Currency codes are stored as upper-case ISO-4217 (e.g. "CAD", "USD", "GBP").

ALTER TABLE menus ADD COLUMN currency TEXT NOT NULL DEFAULT 'CAD';
