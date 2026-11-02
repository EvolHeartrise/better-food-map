-- Migration 0029: menu_watch_urls + menus.last_checked — source change detection.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Refresh selection is pure staleness (last_verified ascending), so a menu
-- whose source has not changed a byte still costs a full agent re-extraction
-- every time it comes up. This table stores a normalized content fingerprint
-- per FETCH url so a deterministic pre-flight (scripts/menu-fingerprint/) can
-- prove "source unchanged" for pennies and skip the agent pass entirely.
--
-- These are FETCH urls, not provenance: `menu_sources` deliberately holds the
-- 1-3 human-browsable pages a reader opens to trust the data, while the thing
-- worth fingerprinting is the ordering-API feed, the nutrition PDF, or the
-- full multi-page inventory banked in `refresh_notes`. The two sets overlap
-- but are not the same, so watch urls get their own rows.
--
--   kind          how the url is fetched + normalized before hashing:
--                 'feed' (JSON, volatile keys stripped, keys sorted),
--                 'pdf' (extracted text), 'html' (visible text of the raw
--                 response), 'rendered' (visible text of the post-JS DOM via
--                 headless Chromium — for pages whose raw HTML is an empty
--                 shell).
--   content_hash  sha256 of the full normalized content, prefixed with the
--                 normalization variant (e.g. "text:<hex>", "bytes:<hex>") so
--                 hashes produced by different pipelines can never compare
--                 equal by accident. NULL when the fetch failed.
--   signal_hash   sha256 of just the menu-shaped signal (the sorted multiset
--                 of visible-text lines carrying a price token). Compared in
--                 preference to content_hash for html/rendered pages, where
--                 banners/hours/review counts churn the full text weekly but
--                 the price list does not. NULL when the page shows no price
--                 lines (comparison then falls back to content_hash).
--   etag / last_modified   HTTP validators for conditional GETs — a 304 skips
--                 even the normalization work.
--   fetch_status  'ok' | 'http_error' | 'blocked' (bot wall) | 'degenerate'
--                 (fetched but the normalized text is too thin to be the real
--                 page). Anything but 'ok' means the row carries no trustworthy
--                 fingerprint, and the menu routes to the agent path — the
--                 mechanism fails open, never below today's behavior.
--
-- Rows are written by scripts/menu-fingerprint/baseline.ts after a successful
-- agent refresh and re-checked by scripts/menu-fingerprint/check.ts before the
-- next one. Cascade with the menu like menu_sources.

CREATE TABLE IF NOT EXISTS menu_watch_urls (
	menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('feed', 'pdf', 'html', 'rendered')),
	content_hash TEXT,
	signal_hash TEXT,
	etag TEXT,
	last_modified TEXT,
	checked_at TEXT NOT NULL,
	fetch_status TEXT NOT NULL CHECK (fetch_status IN ('ok', 'http_error', 'blocked', 'degenerate')),
	PRIMARY KEY (menu_id, url)
);

-- menus.last_checked: date the fingerprints last CONFIRMED the source
-- unchanged. Deliberately distinct from last_verified — "the bytes are stable"
-- is a weaker claim than "an agent re-verified the data against the source",
-- and an unchanged hash cannot see a page newly added to the site nav, so
-- last_verified keeps driving the periodic full-refresh floor.

ALTER TABLE menus ADD COLUMN last_checked TEXT;
