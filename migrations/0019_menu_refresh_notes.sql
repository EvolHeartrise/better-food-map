-- Migration 0019: menus.refresh_notes — bank menu-source discovery knowledge.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Re-verifying a chain menu is dominated by re-DISCOVERING how to read its
-- source: the ordering-API endpoint behind a client-rendered menu page, the
-- nutrition-PDF path, fetch caveats (timeouts, structured feed vs HTML). That
-- knowledge is a property of the MENU — like region, currency and sources, it
-- is said once per menu — so it lives on the row instead of in session notes.
-- Free-form text, written/read via create_menu/update_menu/get_menu. Additive
-- and nullable: nothing existing changes.

ALTER TABLE menus ADD COLUMN refresh_notes TEXT;
