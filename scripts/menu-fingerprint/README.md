# menu-fingerprint — the menu-source change gate

Agent-based menu refreshes are expensive, and refresh selection is pure
staleness — so a menu whose source hasn't changed a byte still costs a full
Sonnet extraction every time it comes up. This module makes "unchanged" cheap
to prove: it stores a **normalized content fingerprint** per source url
(`menu_watch_urls`, migration 0029) and re-checks them deterministically —
zero agent tokens — before the `menu-refresh` workflow spends any.

## Flow

```
bun run menu:check --limit 10        # BEFORE the workflow
  → hash-stable menus: menus.last_checked stamped, skipped
  → changed/unfetchable/never-baselined menus: printed as `needs_refresh`
    (exact `menus`-arg shape) — hand these to the menu-refresh workflow

… menu-refresh workflow runs on only those menus …

bun run menu:baseline <menu_id> …    # AFTER the workflow (report's baseline_next)
  → re-fingerprints each refreshed menu's watch urls as the new baseline
```

Watch urls derive from the menu's banked knowledge: `menu_sources` +
every url in `refresh_notes` (socials/map hosts dropped). They are **fetch**
urls, deliberately separate from the user-facing provenance in `menu_sources`
— the thing worth fingerprinting is often the ordering-API feed or nutrition
PDF that policy keeps _out_ of the sources list.

## How pages become hashes

Raw bytes never hash stably (nonces, CSRF tokens, asset fingerprints), so each
url is normalized by `kind` before hashing (`normalize.ts`):

| kind       | pipeline                                                             |
| ---------- | -------------------------------------------------------------------- |
| `feed`     | parse JSON → drop volatile keys (timestamps/tokens/ids) → sort keys  |
| `pdf`      | `pdftotext` text (bytes churn on regeneration; text doesn't)         |
| `html`     | visible text only — tags, scripts, styles, attributes, comments gone |
| `rendered` | post-JS `innerText` via headless Chromium (bench recorder's binary)  |

For html/rendered pages a second **price-line signal** (the sorted multiset of
text lines carrying a price token) is compared in preference to the full text
hash when both sides have one — banners/hours/review widgets churn weekly, the
price list doesn't. Hashes are prefixed by pipeline (`feed:`/`text:`/`bytes:`)
so different pipelines can never compare equal by accident.

## Fail-open guarantees

The gate can only ever _save_ agent work, never silently skip a real change:

- Any fetch failure, bot wall (`looksLikeBotWall`), degenerate/thin page,
  missing baseline, or hash mismatch routes the menu to the agent path.
- Comparison is **strict**: one permanently-blocked watch row keeps the whole
  menu on the agent path (a walled page might be the primary surface). Curate
  such menus with `menu:baseline <id> --urls <good urls…>`.
- An unchanged hash stamps `menus.last_checked`, never `last_verified` —
  hash-stability can't see a page newly added to the site nav, so verification
  age keeps accruing and `--max-age-days` (default 180) eventually forces a
  real agent pass regardless.
- A check sweep never overwrites baseline hashes/validators except on rows
  that compared stable (persisting a new etag on a changed row would let the
  next conditional GET 304 against content we never accepted).

## Files

- `normalize.ts` / `decide.ts` / `urls.ts` — pure, unit-tested
- `fetcher.ts` — fetch + normalize + hash one url (conditional GETs, Chromium)
- `db.ts` — D1 HTTP access + persistence contract
- `check.ts` / `baseline.ts` — the two CLIs (`menu:check` / `menu:baseline`)
