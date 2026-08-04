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
- When a source itemizes ONE dish at MULTIPLE prices (sizes/serving formats:
  bowl/cup, 5 oz/9 oz/bottle), each variant is its own item named
  `<dish name exactly as displayed> (<variant label, in the source's own word>)`
  — e.g. `Fresh Soup (Bowl)`, `… BC VQA (5 oz)`. A single-price item gets NO
  trailing parenthetical. Keep the FULL displayed name including any
  origin/appellation qualifier on its line (`… Smooth Red, BC VQA`), and for a
  size variant shown with vendor slang (`8oz halfer`, `16 oz sleeve`) use just
  the measured volume (`(8 oz)`, `(16 oz)`). The linter accepts a variant name when either the full
  name or its base with trailing `(…)` groups removed (stripped repeatedly, so a
  `(size) (Happy Hour)` double suffix still resolves to the bare dish name) is in
  the snapshot, so the base must be verbatim but the labels themselves are not
  corpus-checked. Add-ons and upsells (`Add Noodles`, `Extra Chutney`) remain non-items.
- A Happy Hour item is a source-designated price context: it is its own item,
  distinct from any regular-menu version, carrying its Happy Hour price, with the
  literal suffix ` (Happy Hour)` appended to the END of its name (e.g.
  `Sweet-Chili Cauliflower (Happy Hour)`). When the item also has a size/serving
  variant label, `(Happy Hour)` comes LAST, after it:
  `Stone Road Red Blend (5 oz glass) (Happy Hour)`.
- A day-of-week drink special (a "Daily Drink Specials" section) is the same idea:
  its own item at the special price, with ` (<Day> Daily Special)` appended LAST
  (e.g. `House Lemonade (Monday Daily Special)`,
  `Stone Road Red White & Rose (5 oz) (Wednesday Daily Special)`). Dietary tags
  are source-asserted, but a WHOLE-VENUE claim counts for every item: a venue
  that presents itself as plant-based/vegan (even on an about page, not just the
  menu) designates `vegan` for EVERY item on its menu, drinks included — so at
  MeeT (a plant-based venue) every item, wine and beer too, carries `vegan`.
- A named listing shown at a rotating / market price (`Rotating Taps`,
  `Rotating Canned Kombucha`) IS an item — keep it with `price: null`.
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
its first occurrence, the rest count as hallucinations). Name matching is
paren-insensitive: parentheses are dropped before normalizing, so a variant like
`Fresh Soup (bowl)` matches `Fresh Soup bowl` in either direction. The JSON report goes to
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
# OpenRouter backend (default) — any OpenAI-compatible model, billed to the key
OPENROUTER_API_KEY=sk-... bun run bench:run bench/tasks/<slug> --model <openrouter-model-id>

# Claude backend — a Claude model billed to your Claude Code SUBSCRIPTION
bun run bench:run bench/tasks/<slug> --model claude-sonnet-5 --backend claude
```

`--backend openrouter|claude` (default `openrouter`; exit 2 on an unknown value)
picks how the same task is driven:

- **`openrouter`** — an OpenAI-compatible tool-calling loop (non-streaming) via
  OpenRouter. Requires `OPENROUTER_API_KEY` (exit 2 if unset).
- **`claude`** — the SAME task run through the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`). `--model` takes a Claude model id/alias
  (e.g. `claude-sonnet-5`, `haiku`). It uses your logged-in Claude Code
  credentials automatically, so the run **bills your Claude subscription** and
  needs NO `OPENROUTER_API_KEY`. The model is locked to the same two in-process
  tools and the byte-identical system prompt as the OpenRouter path — it has NO
  Bash/Read/WebFetch/file access — so cross-backend scores stay comparable.

Either backend scores what the model extracts against the task's gold. The model
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

### Reasoning effort & temperature

```bash
# reasoning depth on either backend
bun run bench:run bench/tasks/<slug> --model anthropic/claude-sonnet-5 --effort high
bun run bench:run bench/tasks/<slug> --model claude-sonnet-5 --backend claude --effort xhigh

# sampling temperature — OpenRouter backend only
bun run bench:run bench/tasks/<slug> --model openai/gpt-5 --temperature 0.2
```

- **`--effort <level>`** sets the model's reasoning depth. Both backends accept
  it, but their level sets differ, so `--effort` is validated against the chosen
  backend (the error lists that backend's levels):
  - **openrouter** — passed through as OpenRouter's top-level unified reasoning
    parameter, `reasoning: { effort }`. Accepted:
    `none | minimal | low | medium | high | xhigh | max`. Omitted entirely when
    the flag is absent, so the provider default applies (`meta.effort_default`:
    `provider-default`). For Anthropic models that default is **adaptive thinking
    at effort `high`** (the Anthropic API default).
  - **claude** — wired to the Agent SDK's `Options.effort` (`EffortLevel`).
    Accepted: `low | medium | high | xhigh | max` (the SDK has no
    `none`/`minimal`). Omitted when absent, so the **Claude Code harness default,
    `xhigh`, applies** (`meta.effort_default`: `claude-code-default`). Note the
    SDK's own documented default for `effort` is `high`; the Claude Code CLI
    raises the effective default to `xhigh`.
- **`--temperature <n>`** (a finite number) sets top-level `temperature` on the
  **openrouter** request only, and is omitted when absent. It is **not** gated
  per model client-side: it is passed straight through and the provider rejects
  it where unsupported — current Anthropic models (**Sonnet 5, Opus 4.7+**)
  **reject `temperature`/`top_p`/`top_k` with an HTTP 400**, which surfaces as the
  usual upstream OpenRouter error. On the **claude** backend `--temperature`
  exits 2: the Agent SDK exposes no sampling control and those models reject it
  anyway.

**Pre-flight parameter validation (openrouter).** When you pass `--effort` and/or
`--temperature`, the run first checks them against the model's
`supported_parameters` (from the same `GET /api/v1/models` payload fetched once per
run for pricing) and exits 2 BEFORE any chat request if a knob is unsupported —
`--effort` needs `reasoning` or `reasoning_effort`, `--temperature` needs
`temperature` (this catches e.g. `anthropic/claude-sonnet-5 --temperature` up
front instead of burning a request on a provider 400). The error names the model
and prints its actual `supported_parameters`. This is a courtesy, never a gate: if
the models endpoint can't be fetched/parsed or the model id isn't found, it prints
a one-line skip warning to stderr and proceeds — a network blip must never fail a
run the provider would have accepted.

`meta.json` records both settings on **both** backends: `effort` (the requested
level, or `null` when unset), `temperature` (the requested number, or `null` —
always `null` on the claude backend), and `effort_default` (a short factual note
of which default applied when `effort` is null: `provider-default` for
openrouter, `claude-code-default` for claude).

Options: `--max-tool-calls N` (default 40; on the Claude backend it maps to the
SDK's `maxTurns`). The run aborts as failed if the model exhausts its budget,
stops calling tools without submitting (OpenRouter path nudges once first), or
can't produce a valid submission. On the Claude backend a valid submit ends the
run by interrupting the streaming query (via an `AbortController`) and ignoring
any further turns.

**Prompt caching + cache observability.** On the OpenRouter backend, requests to
`anthropic/*` models carry Anthropic prompt-cache breakpoints (`cache_control`):
a static one on the system prompt and a rolling one on the last text-bearing
message each turn, so the growing prefix is cache-read across turns. Non-Anthropic
OpenRouter models are left byte-identical (they cache implicitly by prefix). Every
request also sends `usage: { include: true }`, and the Claude backend reads usage
straight from the SDK result — so both backends report cache accounting.

Each run writes `bench/runs/<task-slug>/<iso-timestamp>-<model-slug>/`:
`candidate.json` (submitted extraction), `report.json` (`scoreCandidate` output),
`transcript.jsonl` (one event per request/response and tool call/result, with
per-request token + cache usage), and `meta.json`. `meta.json` records `model`,
`backend`, `effort` / `temperature` / `effort_default` (see above), timings,
status, and token totals: `prompt_tokens`,
`completion_tokens`, `total_tokens`, `cached_prompt_tokens` (prompt tokens served
from a provider cache), `cache_write_tokens` (tokens written into a cache), and
`total_cost_usd` when the provider surfaces it (the Claude backend). Cache fields
are `0` when the provider reports nothing. `bench/` is gitignored, so runs stay
out of git. Exit 0 on a scored run, 1 on a failed run, 2 on usage/config errors.

**Provider & quantization provenance (openrouter).** OpenRouter routes each
request to one of many upstream providers, and those providers differ in price
**and in quantization** — `deepseek/deepseek-v4-flash-0731`, for example, is
served by 18 endpoints spanning fp4, fp8 and `unknown`. Default routing is
cheapest-first, which biases toward the MOST quantized endpoint. A score reported
without this is unattributable: it measures model × provider × quantization, not
the model.

So every run records who actually served it:

- **`transcript.jsonl`** — per response event, `provider` and `response_id`
  (OpenRouter's generation id, the handle for a later `/api/v1/generation`
  lookup). Per REQUEST, because OpenRouter can re-route mid-run.
- **`meta.json`** — `providers` (distinct, first-seen order),
  `provider_quantizations` (those providers resolved to tiers, e.g.
  `{"DeepInfra":"fp4"}`), and `quantization_requested` (the pin, or `null`).
- **stderr** — `served by  GMICloud @ fp8 [pinned: fp8]`, with a loud
  `** RE-ROUTED MID-RUN **` when more than one provider served a single run.

`quantization_requested: null` means **unpinned**, i.e. cheapest-first routing —
it does NOT mean unquantized. Likewise an absent entry in
`provider_quantizations` is a lookup gap, never evidence of no quantization.

To pin routing to a tier:

```bash
bun run bench:run bench/tasks/<slug> --model <id> --effort high --quantization fp8
bun run bench:run bench/tasks/<slug> --model <id> --quantization fp8,bf16
```

`--quantization` takes a comma-separated list validated against OpenRouter's
tiers (`int4 int8 fp4 fp6 fp8 fp16 bf16 fp32 unknown`; a typo exits 2 before
spending) and is sent as `provider.quantizations` with **`allow_fallbacks:
false`** — a silent fallback to another tier would reintroduce exactly the
confound the pin removes, so the request fails loudly instead. It is
openrouter-only (exit 2 with `--backend claude`, which has no provider routing).

**Assistant-turn normalization.** A model may return a turn with neither
`content` nor `tool_calls` (a reasoning-only turn). Echoing that back verbatim is
invalid under the OpenAI schema, and providers disagree on enforcement —
DeepInfra accepts it, GMICloud 400s the whole request — which made harness
behaviour depend on routing. Such a turn has its `content` normalized to `''`
before being sent back; the transcript still records the model's original message
verbatim.

**Wall-clock.** Every run — scored OR failed — records two durations on
`meta.json`, and prints both to stderr as a `wall-clock …` line under the score
summary:

- `duration_ms` (from `started_at`) — the **agent run**: from just before the
  first model request through scoring. This is the number to compare across
  models; it excludes bench setup.
- `wall_clock_ms` (from `invoked_at`, the process-start instant) — the **TOTAL**
  wall-clock of the whole `bench:run` invocation: manifest/gold load, the one-off
  `GET /api/v1/models` pricing fetch, the agent run, and scoring. Always
  `>= duration_ms`; the gap is bench overhead, not model time.

Both are plain elapsed wall-clock. Tool calls are served in-process from the
snapshot, so a model's time is essentially its own latency — but note
`duration_ms` still includes the (small) local `fetch_page` time.

**Run cost (openrouter backend only).** On the `openrouter` backend `meta.json`
also carries two USD cost fields (absent on the Claude backend, which reports
`total_cost_usd` instead):

- `price` — the **REAL billed cost of the run in USD**: the sum of the per-request
  `usage.cost` values OpenRouter returns when usage accounting is enabled
  (`usage: { include: true }` is sent on every request; OpenRouter credits are
  denominated in USD). Requests missing a cost are skipped; `price` is `null` when
  no request carried cost info at all.
- `price_cached` — the **HYPOTHETICAL cost of the same run under perfect prefix
  caching**. Definition: the bench loop is append-only, so request _i_'s prompt is
  request _i-1_'s prompt plus new tokens; assume every token of request _i_'s
  prompt that was already in request _i-1_'s prompt is billed at the model's
  cache-read rate, the remainder at the normal input rate, and completions at the
  output rate; request 1 is fully uncached; cache-WRITE premiums are ignored
  (idealized). It is computed from the per-request usage sequence plus the model's
  per-token pricing, fetched once per run from OpenRouter's public models endpoint
  (`GET /api/v1/models` → `pricing.prompt`, `pricing.completion`,
  `pricing.input_cache_read`). `price_cached` is `null` when that pricing can't be
  fetched or the model isn't found; a model with no `input_cache_read` rate falls
  back to the prompt rate (no cache discount, noted on stderr). Note that OpenRouter's
  `prompt_tokens` already INCLUDES the cached prefix (`cached_tokens` is a subset),
  so each request's full prompt size is used directly as the prefix length.

## Authoring workflow

1. `bench:record` the venue.
2. `bench:serve --rewrite` and click through the replayed site yourself — every
   menu page, drinks/dessert/brunch tabs, PDFs.
3. Check `serve-misses.jsonl` and `/__report__`; re-record with `--url` for holes.
4. Only when the snapshot browses clean, hand-author `gold/data.json`.
5. `bun run bench:lint` until clean.

## Pruning the test matrix (`bench:blacklist`)

As the bench grows, the cost of a full sweep is (models × configs × tasks). The
blacklist is how that matrix gets narrowed: a record of model/config combinations
already TESTED and judged not worth testing again, so the same verdict is never
re-purchased.

```bash
bun run bench:blacklist                                  # list entries
bun run bench:blacklist --add --model <id> [--effort <level>] [--backend <b>] \
                        --reason <text> [--evidence <text>]
bun run bench:blacklist --remove --model <id> [--effort <level>] [--backend <b>]
bun run bench:blacklist --check  --model <id> [--effort <level>]   # exit 0 allowed, 1 blocked
```

`bench:run` and `bench:draft` consult it **first** — before the API-key check,
before the models fetch, before any chat request — so a blacklisted run costs
nothing. They **exit 3** (not 2) and print the entry's reason, date, and
evidence: a sweep driver can treat 3 as "deliberately skipped" and keep going,
while 2 still means "you misconfigured this."

Entries live in **`scripts/bench/blacklist.json`**, deliberately NOT under
`bench/` — that directory is gitignored, and these verdicts are durable knowledge
that has to survive a machine change and be reviewable in a diff. Each entry is:

| field      | meaning                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `model`    | model id as passed to `--model` (matched case-insensitively)                                              |
| `effort`   | a level name, `default` (only runs passing no `--effort`), or `*`/omitted (every level, default included) |
| `backend`  | `openrouter` \| `claude`; omitted covers both                                                             |
| `reason`   | **required** — why it was ruled out. A verdict without its why rots into superstition                     |
| `added`    | `YYYY-MM-DD`, so an old verdict against a since-updated model is visible as stale                         |
| `evidence` | optional pointer to the runs that justified it                                                            |

Note `effort: none` and `effort: default` are **different scopes**: `none` is an
explicit reasoning level, `default` is "no `--effort` flag passed". Blacklisting
one does not block the other. To rule a model out entirely, omit `--effort`.

Two escape hatches, because a blacklist you cannot override is a trap — models
get updated and old verdicts expire:

- `--ignore-blacklist` on `bench:run`/`bench:draft` runs the combination anyway
  (it prints a note that it is overriding).
- `--remove` drops the entry for good.

A malformed `blacklist.json` is a hard error rather than an empty list —
silently ignoring a corrupt file would re-enable exactly the spending it exists
to prevent.

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
  --model <openrouter-model-id> [--effort <level>] [--max-tool-calls N] [--policy-version <v>] [--force]
```

`--effort <level>` sets the model's reasoning depth (OpenRouter-only, same level
set and pre-flight `supported_parameters` check as [`bench:run`](#reasoning-effort--temperature)); the requested effort is recorded on the draft transcript and the stderr summary line.

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
