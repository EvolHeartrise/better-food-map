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

## Authoring workflow

1. `bench:record` the venue.
2. `bench:serve --rewrite` and click through the replayed site yourself — every
   menu page, drinks/dessert/brunch tabs, PDFs.
3. Check `serve-misses.jsonl` and `/__report__`; re-record with `--url` for holes.
4. Only when the snapshot browses clean, hand-author `gold/data.json`.
5. `bun run bench:lint` until clean.
