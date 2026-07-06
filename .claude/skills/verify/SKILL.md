---
name: verify
description: Build, launch and drive better-food-map locally to observe a change working — local D1 setup, dev server, and headless-browser driving recipe.
---

# Verifying better-food-map changes at runtime

## Local D1 (required before the app serves data)

`.wrangler/state` is gitignored; in a fresh worktree, copy the miniflare D1
store from the primary checkout, then apply any migrations it lags:

```bash
mkdir -p .wrangler/state/v3/d1
cp -r <primary-checkout>/.wrangler/state/v3/d1/miniflare-D1DatabaseObject .wrangler/state/v3/d1/
bun run d1:migrate:local
```

Query it for test fixtures (no sqlite3 binary on this box; use bun):

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database(".wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite", { readonly: true }); console.log(JSON.stringify(db.query("select id, name from locations where closed_at is null limit 3").all()));'
```

The local data set is Vancouver-centred (venues like "Revolver",
`/locations/a348c5c2-9171-4dc7-936c-e139d9b963b3` as of 2026-07).

## Launch

```bash
bun run dev --port 5199 > /tmp/dev-server.log 2>&1 &
# ready in ~2s; SSR smoke test:
curl -s http://localhost:5199/ | grep -o "<title>[^<]*</title>"
curl -s http://localhost:5199/locations/<id> | grep -o "<title>[^<]*</title>"  # venue head + panel SSR
```

## Drive (headless browser)

No playwright in devDependencies; `bun add playwright` in a temp dir and point
`executablePath` at a cached browser — `~/.cache/ms-playwright/
chromium_headless_shell-<n>/chrome-headless-shell-linux64/chrome-headless-shell`
(the package's own download may not match the cached build numbers).

Flows worth driving, with the selectors that matter:

- Venue deep link: `.placecard__name`, `.placecard__item` count; close via
  `.placecard__close` (panel outro → `.placecard` count drops to 0).
- Search: fill `.searchpill__input`, wait >250 ms (debounce), watch network
  requests containing `getMapCells`; results list is `.results__item`
  (capped at 50). Clearing the search must issue NO new getMapCells call
  (warm browse cells replay from the client store).
- Failure status: `page.route('**/getMapCells*', abort)` then search →
  `.searchstatus` shows "Search failed - showing previous results." and the
  `.searchpill__spinner` clears.

## Gotchas

- The landing overlay hides the searchbar until zoomed in; opening a
  `/locations/<id>` deep link (then closing the panel) is the quickest way to
  a zoomed-in, searchable map.
- The map canvas is MapLibre; marker pills are aria-hidden — assert venues via
  the `.results` list or the detail panel, not the canvas.
