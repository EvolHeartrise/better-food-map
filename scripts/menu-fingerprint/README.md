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

For html/rendered pages a second **menu signal** — the sorted multiset of
price-bearing lines, their immediate neighbour lines (menus split items across
lines: "Pad Thai" / "16.95"), and every dietary/allergen-marker line — is
compared in preference to the full text hash when both sides have one:
banners/hours/review widgets churn weekly, the menu body doesn't. Hashes are
prefixed by pipeline (`feed:`/`text:`/`bytes:`) so different pipelines can
never compare equal by accident. Two guards close the "stable shell" holes: a
200 html page with **no** price signal is promoted to the rendered tier at
baseline (an SPA/iframe menu leaves the raw HTML as a nav/footer shell that
would hash stable forever — and the rendered tier reads `innerText` across
**all frames**, so iframe menus are covered), and a PDF whose extracted text
is empty/thin (a scanned image menu) falls back to **byte** hashing, where a
re-uploaded scan always reads as changed.

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
- Conditional GETs can't coast forever: rows whose validators are older than
  30 days re-fetch unconditionally, so a lying etag/Last-Modified is bounded.

## Known blind spots (they ride the `--max-age-days` floor)

- On a noisy html/rendered page where the signal comparison is in effect, a
  change **2+ lines away from every price line** that carries no
  dietary/allergen token (e.g. a reshuffled unpriced tasting-menu blurb) does
  not move the signal.
- A source that serves different content per visitor/geo may hash stable from
  this vantage while changing elsewhere.
  The floor guarantees a real agent pass at most `--max-age-days` (180) after
  the last verification regardless of hash stability.

## Files

- `normalize.ts` / `decide.ts` / `urls.ts` — pure, unit-tested
- `fetcher.ts` — fetch + normalize + hash one url (conditional GETs, Chromium)
- `db.ts` — D1 HTTP access + persistence contract
- `check.ts` / `baseline.ts` — the two CLIs (`menu:check` / `menu:baseline`)
