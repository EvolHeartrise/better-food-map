# Menu-extraction bench tooling

Tools for authoring the hand-made menu-extraction benchmark: freeze a venue's
website into a replayable snapshot, then hand-author gold menu data against it.

`bench/` is **deliberately gitignored** (snapshots run ~60MB/venue) — keep the
bench data backed up outside the repo. CI runs `bench:lint`, which skips cleanly
when `bench/tasks` is absent; only the tooling and its tests live in git.

## Layout of a bench task

```
bench/tasks/<venue-slug>/
  manifest.json          # entry URL, snapshot dates, crawled pages, warnings
  snapshot/
    index.json           # every recorded HTTP exchange (method, url, status, body file)
    bodies/              # response bodies, one file per exchange
    rendered/            # post-JS rendered DOM per navigated page
  serve-misses.jsonl     # requests the replay could not serve (append-only)
  gold/data.json         # hand-authored ground truth
```

## Gold format (`gold/data.json`)

```json
{
	"policy_version": "2026-07-11",
	"sources": ["https://venue.com/menu"],
	"items": [
		{
			"name": "…",
			"description": "verbatim or null",
			"tags": [],
			"optional_tags": [],
			"price": 9.99
		}
	]
}
```

- `sources` is the ground truth for source reporting: every URL the menu data
  came from. An agent must be able to report all of them; how it navigated
  there is not scored.
- Tags use the app's six dietary ids only (`vegan`, `vegetarian`, `gluten_free`,
  `dairy_free`, `nut_free`, `halal`) — course tags are deliberately NOT scored
  by this bench. Store tags minimally (e.g. `vegan` alone); the scorer expands
  the vegan → vegetarian + dairy_free implication on both sides before comparing.
- `description` is the venue's own menu text verbatim, else `null`.
- `warning` is an optional terse note flagging an OBVIOUS source contradiction
  (e.g. a "Vegan" label on an item whose description lists paneer): a non-empty
  string means "flag it", `null` or an omitted key means "no warning". Scoring is
  presence-only — whether each side flagged the item, never the wording — so the
  string content is authored judgment and is NOT checked against the snapshot.

Validate with `bun run bench:lint [task-dir...]` (defaults to all tasks): schema
and vocabulary checks, and every item name / source URL must exist in the task's
own snapshot — a zero-hit name is a gold typo or a snapshot hole.

## Recording a snapshot

```bash
bun run bench:record bench/tasks/<slug> https://venue.example.com
```

Crawls same-origin pages breadth-first (menu-shaped URLs prioritized), recording
**every** network response on any host — this is how ordering-API JSON, menu
PDFs, and cross-origin assets get captured — plus each page's rendered DOM.
Linked PDFs are fetched directly. Re-running **merges**: same responses are
replaced, new ones appended, so topping up a snapshot is safe.

Options: `--url <u>` visit extra URLs (repeatable — use for pages behind clicks
or on other hosts), `--max-pages` (40), `--max-depth` (4), `--wait <ms>` extra
settle time (1500), `--headed` visible browser.

Watch the summary for `possible bot-wall` warnings and the `page budget
exhausted` warning. Uses the Chromium cached under `~/.cache/ms-playwright`
(override with `BENCH_CHROME=/path/to/chrome`).

## Replaying a snapshot

```bash
bun run bench:serve bench/tasks/<slug> --port 8787
```

- `/<path>` → the venue's primary host; `/__origin__/<host>/<path>` → any other
  recorded host (APIs, CDNs).
- `/__rendered__?url=<original-url>` → the post-JS rendered DOM of a crawled page.
- `/__report__` → coverage JSON: hits, misses, and recorded-but-never-requested.
- Any request not in the snapshot 404s and is appended to `serve-misses.jsonl` —
  browse the replay, then treat the miss log as the re-record to-do list.
- `--rewrite` rewrites recorded-host URLs inside HTML/CSS/JS/JSON bodies to point
  back at the replay server, for human browsing in a real browser. Leave it off
  for agent evals: bodies stay byte-faithful to what the site served.

## Scoring a candidate extraction

```bash
bun run bench:score bench/tasks/<slug> <candidate-output.json>
```

Deterministically scores a candidate menu (same shape as `gold/data.json`, but
`policy_version` is optional) against the task's gold. NO fuzzy matching, NO LLM:
candidate items match gold items only by exact `normalizeForSearch(name)`
equality (each side matched at most once; a repeated candidate name matches on
its first occurrence, the rest count as hallucinations). The JSON report goes to
stdout (pipe/save it); a short summary goes to stderr. Exit 0 on any successful
scoring however bad the scores; exit 2 on a missing/invalid candidate or gold
file. Metrics (recall and precision are always reported separately, never
averaged together):

- `item_recall` / `item_precision` — matched items over gold / candidate totals.
- `missed_items` / `hallucinated_items` — unmatched gold / candidate item names.
- `tag_precision` / `tag_recall` — micro-averaged dietary tags over matched pairs, after expanding vegan → vegan+vegetarian+dairy_free on both sides.
- `optional_tag_precision` / `optional_tag_recall` — same, over `optional_tags`.
- `tag_false_positives` — `{item, tag}` the candidate asserted that gold (expanded) lacks; these are the dangerous free-of/safety claims, surfaced explicitly. A tag the candidate did not assert literally but that appeared via the vegan expansion carries `implied_by` (e.g. `dairy_free` implied by `vegan`) so implied FPs read clearly instead of looking like direct assertions.
- `price_accuracy` — exact numeric equality over matched pairs (`null === null` counts correct).
- `description_accuracy` — equality after `normalizeForSearch` over matched pairs (`null === null` correct; `null` vs text incorrect).
- `warning_accuracy` — presence-only agreement on the `warning` flag over matched pairs: a warning counts as present iff it is a string (`null`/absent are "no warning"), and the CONTENT is never compared.
- `missing_warnings` / `spurious_warnings` — matched item names where gold flags a warning the candidate lacks / the candidate flags one gold lacks.
- `source_recall` / `source_precision` — candidate vs gold sources compared after `normalizeUrl`. A candidate source that is a site ROOT page (normalized pathname exactly `/` with no query string) which gold does not itself list is IGNORED — excluded from the precision denominator (neither hit nor miss) and reported in `ignored_sources`; `source_recall` is unaffected. A root URL gold DOES list scores as a normal hit.
- `gold_items` / `candidate_items` / `matched` — raw counts.

## Running a model against a task

```bash
OPENROUTER_API_KEY=sk-... bun run bench:run bench/tasks/<slug> --model <openrouter-model-id>
```

Drives an OpenAI-compatible tool-calling loop (via OpenRouter, non-streaming)
against the task's frozen snapshot and scores what the model extracts. The model
never touches the real network — its two tools are served in-process:

- `fetch_page({ url })` — resolves the URL against the task's SnapshotStore
  (scheme-swap fallback). HTML pages return the rendered DOM as text plus a
  `links` array (all hosts) scraped from the page; JSON/text bodies pass through;
  PDFs return a byte-count stub; anything not recorded returns `{ status: 404 }`.
  Returned text is capped at 60,000 chars with a `[truncated: N of M chars]` marker.
- `submit_menu(payload)` — validated against the scorer's `CandidateSchema`.
  Validation failures are handed back as issues so the model can re-submit (up to
  3 attempts); a valid submission ends the run. On a valid submission each item's
  `description` is deterministically stripped of trailing list-delimiter junk
  (whitespace, commas, straight/curly quotes, backticks) that models occasionally
  leak onto the end of the string — a fixed cleanup applied equally to every
  submission, consulting no snapshot or gold data; the raw submitted text is still
  preserved verbatim in the transcript.

Options: `--max-tool-calls N` (default 40). Requires `OPENROUTER_API_KEY` (exit 2
if unset). The run aborts as failed if the model exhausts its tool-call budget,
stops calling tools without submitting (nudged once first), or can't produce a
valid submission.

Each run writes `bench/runs/<task-slug>/<iso-timestamp>-<model-slug>/`:
`candidate.json` (submitted extraction), `report.json` (`scoreCandidate` output),
`transcript.jsonl` (one event per API request/response and tool call/result, with
token usage), and `meta.json` (model, tokens, timings, status). `bench/` is
gitignored, so runs stay out of git. Exit 0 on a scored run, 1 on a failed run,
2 on usage/config errors.

## Authoring workflow

1. `bench:record` the venue.
2. `bench:serve --rewrite` and click through the replayed site yourself — every
   menu page, drinks/dessert/brunch tabs, PDFs.
3. Check `serve-misses.jsonl` and `/__report__`; re-record with `--url` for holes.
4. Only when the snapshot browses clean, hand-author `gold/data.json`.
5. `bun run bench:lint` until clean.

## Authoring at scale

Two tools speed up filling the bench without lowering the bar that gold is
hand-verified.

### `bench:new` — scaffold a task + track strata coverage

```bash
bun run bench:new <slug> <entry-url> --stratum <name>   # scaffold a task dir
bun run bench:new --status                              # coverage matrix
bun run bench:new --claim <slug> --stratum <name>       # claim an existing dir
```

The canonical strata are `single-page`, `multi-page`, `api-backed`, `pdf-menu`,
`allergen-legend`, `closed-venue`, `bot-walled` — one per hard case the
extractor has to handle. Scaffolding validates the slug (kebab-case), the entry
URL, and the stratum, writes `task.json` (`{ slug, entry_url, stratum,
created_at }`), and prints the next commands (`bench:record`, `bench:serve`,
`bench:lint`). It does **not** crawl — recording is a separate step. It refuses
to overwrite an existing task dir.

`--status` prints which strata are filled (EMPTY markers for the gaps) and a
per-task table: snapshot recorded, gold authored, draft pending, and item count.
A task with no `task.json` (e.g. one recorded before this tooling existed) shows
stratum `(unset)`; `--claim` back-fills its `task.json`. On CI, where `bench/` is
gitignored and absent, `--status` prints a "no bench data" note and exits 0.

### `bench:draft` — model-drafted gold for human review

```bash
OPENROUTER_API_KEY=sk-... bun run bench:draft <task-dir> \
  --model <openrouter-model-id> [--max-tool-calls N] [--policy-version <v>] [--force]
```

Drives the **same** extraction loop as `bench:run` (identical tools, system
prompt, and snapshot-served `fetch_page`) and writes the model's submission to
`<task-dir>/gold/draft.json` — **never** to `gold/data.json`. A draft is machine
output and must **never** be trusted as gold without a human pass. Re-drafting
refuses to clobber an existing `draft.json` unless `--force`; drafting over an
existing `gold/data.json` is allowed (useful for re-verification) and leaves the
gold untouched. `--policy-version` stamps the draft (default `draft`); the human
sets the real value when promoting.

After writing, it prints a **REVIEW checklist** to stderr — this is where a
reviewer starts. It reuses the gold linter against the task's own snapshot, so
it surfaces zero-hit item names (hallucinations or snapshot holes), descriptions
not found verbatim, and unrecorded sources, plus item / dietary-tag / warning
counts and token usage. A transcript lands at `gold/draft-transcript.jsonl` so a
bad draft is debuggable.

**draft → review → promote:** `bench:draft` produces `draft.json` →
a human works the REVIEW checklist in `bench:review` (below) until the badges
clear → promotes to `gold/data.json`. The draft is a starting point, not an
answer key.

### `bench:review` — the gold-review UI

```bash
bun run bench:review <task-dir> [--port 8790] [--file draft|data]
```

A local, self-contained web UI (no build step, no external requests) that turns
hand-reviewing a drafted gold into a glance instead of a text search. Defaults to
`gold/draft.json` if it exists, else `gold/data.json` (exit 2 if neither);
`--file` forces one. All human output is on stderr.

Two panes. **LEFT:** every crawled page (from `manifest.pages`, menu-shaped first)
as extracted, readable text — the same `htmlToText` view the linter and scorer
compare against, so what you read is what gets checked (recorded HTML is never
iframed). **RIGHT:** the item list from the reviewed file, every field editable —
name, description, price (numeric or empty = `null`), the six dietary tags and
`optional_tags` as checkboxes, and the `warning` note. Each item has a delete
button and a "reviewed" toggle.

**The core loop is the zero-hit badge.** Clicking an item highlights and scrolls
to its (normalized) name in the left pane, auto-switching to the first tab that
contains it; an item whose name appears NOWHERE in the snapshot gets a loud
`NO HITS` badge — the draft's main failure mode is rewritten names, so you edit
the name until the badge clears. Hit status recomputes live as you type. The
header shows progress (reviewed n/total, zero-hit count), a save-state indicator,
the editable `sources` list, and a **Promote** button.

Edits autosave back to the reviewed file (`draft.json`/`data.json`), preserving
its `policy_version` and writing the reviewed-name list to
`gold/review-state.json` — review progress lives OUTSIDE the gold so the format
stays lean. **Promote** (draft only) runs `lintGold` on the draft with the chosen
`policy_version`: if any ERRORS remain (a zero-hit name is one) it refuses and
lists them; otherwise it writes `gold/data.json`. It never deletes `draft.json` —
you do that when satisfied. Finish with `bench:lint` until clean.
