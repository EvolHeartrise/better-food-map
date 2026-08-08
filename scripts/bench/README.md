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
- **A trailing `(…)` group marks AUTHORED text: a qualifier the gold adds, which
  the source does not display on the item's own line.** Every case below is one
  of these, and they are all handled by one rule — an item name passes the
  snapshot-membership check when either the full name, or its base with trailing
  `(…)` groups removed (stripped repeatedly, so a `(size) (Happy Hour)` double
  suffix still resolves to the bare dish name), appears in the snapshot. So the
  BASE must be verbatim and the qualifiers are never corpus-checked. Everything
  outside the parentheses is the source's own words; everything inside is ours.

- When a source itemizes ONE dish at MULTIPLE prices (sizes/serving formats:
  bowl/cup, 5 oz/9 oz/bottle), each variant is its own item named
  `<dish name exactly as displayed> (<variant label, in the source's own word>)`
  — e.g. `Fresh Soup (Bowl)`, `… BC VQA (5 oz)`. A single-price item gets NO
  trailing parenthetical. Keep the FULL displayed name including any
  origin/appellation qualifier on its line (`… Smooth Red, BC VQA`), and for a
  size variant shown with vendor slang (`8oz halfer`, `16 oz sleeve`) use just
  the measured volume (`(8 oz)`, `(16 oz)`). Add-ons and upsells (`Add Noodles`,
  `Extra Chutney`) remain non-items.

- **A format disambiguator, when one venue sells the same-named item two ways —
  an AUTHORING convention only, invisible to scoring.** New York Fries lists both
  a poutine and a hot dog as `Bacon Double Cheese`. Gold item names must be unique
  (the linter errors on a collision, and `matchItems` would silently keep only the
  first), so the format goes in a trailing group: the poutine keeps the bare name,
  the dog becomes `Bacon Double Cheese (Dog)`. Use the source's own word for the
  format.

  This costs a model nothing and is deliberately NOT in the system prompt.
  `nameMatchKey` strips parentheses before comparing, so `X (Dog)` and `X Dog` are
  the SAME key — a model that writes the bare suffix, which is what 27 of 36 New
  York Fries runs already did unprompted, matches gold either way. The parentheses
  exist for the READER and the LINTER: without them the name is neither verbatim
  nor marked as authored, which is exactly what made three real gold items read as
  typos. Teaching the convention to the model was measured to be a net loss — every
  literal reading of the instruction ("use the section heading" → `(Premium Dogs)`,
  or qualifying both sides, or qualifying the wrong one) costs 3 misses and 3
  hallucinations, and none of them can gain a point the bare suffix does not
  already get.

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
own snapshot — a zero-hit name is a gold typo, an unmarked authored qualifier
(see the `(…)` rule above), or a snapshot hole.

A task with no `gold/data.json` is **skipped, not failed**, when linting all
tasks: `bench:new` scaffolds a task dir before anything is recorded and
`bench:draft` writes `gold/draft.json` and deliberately never `data.json`, so
"recorded, drafted, not yet promoted" is a normal state of the authoring
workflow rather than a defect. Naming that task explicitly
(`bench:lint bench/tasks/<slug>`) still fails — asking for one task by name and
getting silence is its own trap.

The snapshot corpus the membership checks run against is compared under Unicode
NFC and with HTML entities decoded, so a source that spells `sautéed` as
`e`+U+0301 still matches gold's U+00E9, and `caf&eacute;` is `café` rather than
`caf`. An entity the decoder does not know is left INTACT, never replaced with a
space — silently deleting a character is how two identical-looking strings stop
comparing equal. The exception is anything that denotes WHITESPACE or is
invisible (`&thinsp;`, `&shy;`, a zero-width space): those decode to the real
character and `normalizeForSearch` then removes or collapses them, because a
literal `&thinsp;` left between two words glues them together.

**This normalization is shared with the SCORER** (`normalizeForSearch` backs
`nameMatchKey` and description equality), so it is not only a lint change: a
model that submitted NFC text against an NFD snapshot was previously marked
wrong. Rescoring the current corpus, 23 `meetonmain` runs now score slightly
higher on `description_accuracy` than their frozen `report.json` says. The frozen
reports are the historical record and are never rewritten; `bench:viewer`'s
rescore-on-read is what surfaces the difference. Note the corollary: a stored
report and a fresh score can now diverge for a reason that is neither a gold edit
nor a `policy_version` bump, and nothing in `meta.json` records which scorer
version produced it.

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

### Harnesses — testing an agent SETUP, not just a model

`--model`/`--effort`/`--quantization` describe **who** answered. `--harness`
describes **how they were asked**.

```bash
# the original loop (default — nothing changes if you omit the flag)
bun run bench:run bench/tasks/<slug> --model <id> --harness single-pass

# draft, then correct: a second fresh agent reviews the first one's submission
bun run bench:run bench/tasks/<slug> --model <id> --harness two-pass

# cheap drafter checked by a stronger reviewer
bun run bench:run bench/tasks/<slug> --harness two-pass \
  --model deepseek/deepseek-v4-flash-0731 --effort low \
  --review-model openai/gpt-5.6-luna --review-effort xhigh
```

| harness          | passes                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `single-pass`    | one agent extracts and submits                                                                                             |
| `two-pass`       | one agent extracts; a second **fresh** agent corrects it. Scored on pass 2's submission                                    |
| `two-pass-patch` | like `two-pass`, but the reviewer submits **corrections** (ops applied to the draft) instead of re-emitting the whole menu |

**`two-pass-patch` — the reviewer patches instead of re-typing.** On a large menu
a full-re-emission review spends most of its output tokens re-typing items it
never doubted (a 180-item review pass burned 43k completion tokens to change
nothing). The patch reviewer gets a `submit_corrections` tool instead of
`submit_menu`: `add` (full items), `remove` (by name), `update` (per-field, item
named by the scorer's own `nameMatchKey` identity so paren/case differences never
fail a legitimate correction), `set_sources`, and `tag_menu` — a whole-menu
dietary-tag sweep for venue-wide designations, because expressing "every item is
vegan" as ~180 per-item updates measurably under-applies (a reviewer swept only
half the menu that way). An empty object approves the draft unchanged. Ops are validated and applied in-process (`applyCorrections`);
an unknown target name, unknown field, or a post-patch duplicate name comes back
as a validation issue for the model to retry, and the patched result must still
pass the scorer's `CandidateSchema` — one source of truth for what an item is.
On the first 180-item comparison the patch review pass was ~40% cheaper and ~2.3×
faster than the full re-emission at equal quality. **OpenRouter backend only**
(`--backend claude` exits 2: the Agent SDK path does not serve the tool).

**What the review pass gets.** The previous pass's submitted `sources` + `items`,
the entry URL, and the same `fetch_page` snapshot access — nothing else. It does
NOT get the first pass's transcript or reasoning (it is a new agent handed a
draft, not a longer conversation), and it does NOT get gold, a score, or anything
derived from either. That last point is the invariant every harness must hold: a
pass that can see the answer key measures nothing. `harness.test.ts` asserts the
review message serializes only `items` and `sources`, so a future caller passing
an enriched object cannot silently widen what the model sees.

**The review prompt embeds the extraction prompt verbatim.** A reviewer working
from a different rule set is worse than no reviewer: it rewrites correctly-applied
conventions (the variant parenthetical, the whole-venue dietary rule, verbatim
naming) into plausible wrongness, and under exact name matching every such edit
costs a miss AND a hallucination. Composing guarantees both passes are judged by
one standard. On top of the rules it runs a numbered verification CHECKLIST built
from run analysis — page sweep, venue-wide dietary claim, name fidelity (dietary
markers are tags not name text; variant labels verbatim), description
completeness, price/tag check, removals-need-evidence, and evidence-based source
edits. The checklist replaced a gentler "correct the draft" prompt after
measurement showed that prompt was a literal no-op for some models (zero edits
across 13 runs) while its successor produced +5.9pp item recall / +17pp
description accuracy (woodenspoon) and a +47.6pp tag-recall sweep (meetonmain,
whole-venue vegan) within-run. Removal-type checks stay evidence-based because
the same measurements caught the failure modes: an earlier reviewer deleted items
it merely hadn't seen, and an early source-trimming clause cost 12.5pp of source
recall until it was scoped to "remove only what you have confirmed contributed
nothing".

**`--review-model` / `--review-effort` are optional and inherit.** Unset, the
review pass runs the same model and effort as the extraction pass — the
self-correction configuration. Set, you get the drafter/reviewer split. Passing
either on a harness with no review pass is an **error**, not a no-op: silently
ignoring it is how a sweep gets spent believing it tested a reviewer that never
ran.

**A multi-pass run is charged for all of it.** `duration_ms`, every token count
and every cost field on `meta.json` are the run TOTALS across passes, because the
question a two-pass row answers on the Frontier is "what did this setup cost",
not "what did its last stage cost". `meta.passes[]` carries the per-pass
breakdown. A pass that fails to submit ends the harness and **fails the run**,
even if an earlier pass submitted — the setup being measured is the pair, not its
better half.

**Pass 1's answer is kept and scored.** A multi-pass run also writes
`candidate-pass1.json` and `report-pass1.json`, scored against the same gold as
the final report. Without them you can see that a two-pass run scored 94% but not
whether the reviewer earned four points or gave away six. `bench:run` prints the
per-metric effect to stderr, `bench:export` carries it as `pass1_*` and
`review_delta_*` columns, and the viewer gets a **passes** tab.

The effect is reported **per metric and signed, never as one improved/regressed
verdict** — a reviewer routinely recovers a missed page (recall up) while
renaming items it touched (precision down), and the trade is the interesting
part. The viewer also lists items the review pass _recovered_ and items it _lost_,
because swapping one miss for another leaves every ratio flat.

**Page discovery is reported per pass too.** Every transcript event is stamped
with the pass that produced it, so the run detail shows which pages each pass
opened and which a later pass reached first. The whole-run union answers "did this
setup reach every page"; only the split answers "did the reviewer find a page the
extractor missed", which is the hypothesis the harness exists to test.

Adding a harness means adding an entry to `HARNESSES` in `harness.ts` and nothing
else: the runner iterates `passes`, the meta records the name and per-pass prompt
hashes, and the analysis layer already splits cells on both.

### Prompt provenance (`prompt_sha`)

Every run records a content hash of each pass's system prompt, keyed
`<index>-<role>` (`{"1-extract": "a3f1c8…", "2-review": "7d2e94…"}`), and the
aggregation splits cells on it. Two runs sharing a model, provider and effort but
not a prompt are not the same configuration. Provider drift already split cells
and gold drift had two detectors; a prompt edit used to land pre-edit and
post-edit runs in one cell with nothing on screen to say so.

A run predating the field reports `unknown` — an **unknown** prompt, never one
assumed to match today's. Those runs keep their own cell for that reason. The hash
covers the exact string sent to the model, so a whitespace-only edit produces a
new value; the point is detecting that the prompt CHANGED, not judging whether the
change mattered.

Each run also writes **`prompts.json`** — the full prompt text behind each sha,
keyed like `prompt_sha` (`<index>-<role>` → `{ sha, text }`) — so a sha in
`meta.json` resolves from the run directory itself instead of from git
archaeology over `prompts.ts`. Runs predating the file have only their shas.

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
SDK's `maxTurns`). It is a **per-pass** budget: `--max-tool-calls 40 --harness
two-pass` allows 40 fetches in each pass, not 40 across the run. Each pass is a
fresh agent that has to rediscover the site, so a shared budget would starve the
reviewer rather than measure it — but note this is the one axis where a two-pass
run is not charged as a single unit. The run aborts as failed if the model exhausts its budget,
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

Each run writes `bench/runs/<task-slug>/<iso-timestamp>-<model-slug>/` (claimed
atomically at start; two same-task runs launched in the same millisecond get
`-2`, `-3`, … suffixes rather than silently overwriting each other — a real
collision that cost a run's evidence before the claim existed):
`candidate.json` (submitted extraction), `report.json` (`scoreCandidate` output),
`transcript.jsonl` (one event per request/response and tool call/result, with
per-request token + cache usage, each stamped with the `pass` that produced it),
and `meta.json`. A multi-pass run additionally writes `candidate-pass1.json` and
`report-pass1.json` (see [Harnesses](#harnesses--testing-an-agent-setup-not-just-a-model));
`candidate.json`/`report.json` remain the headline result either way, so every
existing reader is unaffected. `meta.json` records `model`, `backend`, `harness`,
`prompt_sha`, `review_model` / `review_effort`, `passes[]`, `effort` /
`temperature` / `effort_default` (see above), timings, status, and token totals: `prompt_tokens`,
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
  caching**. Definition: within a single pass the loop is append-only, so request
  _i_'s prompt is request _i-1_'s prompt plus new tokens; assume every token of
  request _i_'s prompt that was already in request _i-1_'s prompt is billed at the
  model's cache-read rate, the remainder at the normal input rate, and completions
  at the output rate; the first request of each pass is fully uncached; cache-WRITE
  premiums are ignored (idealized).

  **Estimated PER PASS and summed**, for two reasons that both produced wrong
  money when it was done over the merged usage list. Each pass starts a FRESH
  message list under a different system prompt, so the append-only premise is
  false at a pass boundary — pass 2's whole opening prompt (review prompt plus the
  serialized draft) was being billed at the cache-read rate. And rates are
  per-model: on a `--review-model` split, pricing the reviewer's tokens at the
  drafter's rates under-reported the README's own flagship example by ~16x on a
  selectable Frontier axis. `price_cached` is `null` when ANY pass could not be
  priced — a partial counterfactual is not a smaller one, and the error always
  flatters the multi-pass configuration. It is computed from the per-request usage sequence plus the model's
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

## Analyzing results (`bench:viewer`, `bench:export`)

Everything above PRODUCES runs. These two consume them: they read
`bench/runs/**/{meta,report,candidate}.json` (plus `transcript.jsonl` on demand)
and turn 150+ loose run directories into something answerable.

```bash
bun run bench:viewer                      # dashboard on http://127.0.0.1:8792
bun run bench:export --rows cells --format csv --mode macro > cells.csv
bun run bench:export --rows runs > runs.json
```

Both read through the SAME modules (`scripts/bench/analyze/`), so a number on
screen always equals the number in a CSV.

**Write policy — inputs, never evidence.** The viewer's `/api/authoring/*`
routes may write bench INPUTS: `task.json`, `gold/draft.json`,
`gold/data.json`, `gold/review-state.json` — the same files `bench:new` and
`bench:review` write from the CLI. Nothing anywhere in the viewer can write
under `bench/runs`: run evidence is produced only by `bench:run`, and an
analytics tool that could edit its own evidence is a way to lose it.

### `bench:viewer`

A local Vite + Svelte SPA (`bench-viewer/`) served by `Bun.serve`, bound to
**127.0.0.1 only** — it exposes unpublished bench data and has no auth. The UI
bundle builds on demand when it is missing or older than its sources
(`--rebuild` forces, `--no-build` skips and serves the JSON API alone). Options:
`--port` (8792), `--runs-dir`, `--tasks-dir`.

The analytics views all render against ONE shared filter slice (a per-view
filter is how two cards quietly end up describing different data):

- **Leaderboard** — one row per configuration cell, the scorer's metric vector as
  sortable columns. Expanding a row shows its provenance, gold versions and runs.
- **Frontier** — quality against cost or latency, Pareto frontier direct-labelled.
  The cost axis toggles between REAL billed cost and the `price_cached`
  perfect-prefix-cache counterfactual.
- **Tasks** — which venues still separate configurations, and which are at
  ceiling, plus a configuration × task heatmap.
- **Runs / Run detail** — every run, drilling into its full report, the
  name-fidelity split, page-discovery coverage and the turn timeline.
- **Compare** — two runs on the same task, diffed item by item.

Two further tabs sit OUTSIDE the filter slice (they are not run-slice views):

- **Authoring** — `bench:new --status` live: the strata matrix (empty strata are
  the bench's blind spots), the per-task recorded/gold/draft table, task
  scaffolding and stratum claiming, and a path into the **gold editor** — the
  `bench:review` two-pane UI (snapshot text left, editable items right, NO HITS
  badges, debounced autosave, promote gated on a zero-error lint) consolidated
  into this dashboard (`viewer-authoring.ts`). Recording a snapshot stays a CLI
  act (it drives headless Chromium against the live web); the dashboard shows
  the command instead of a button.
- **Sources** — eatery counts per ingestion source, read from the LOCAL stores
  only (`viewer-sources.ts`): the OSM staging store (`data/osm-poi.sqlite`),
  the `overture_leads` table in the same file, and the miniflare D1 mirror of
  the map (its `db:pull` age is displayed, not hidden). `unique` is OSM +
  leads — the leads table already excludes venues near a name-related OSM POI,
  so the sum is a deliberate union estimate — and `remaining` subtracts open
  map locations, by country → province → city. The **ingestion cost forecast**
  multiplies remaining venues by a bench-derived $/menu: pick any cell from the
  current slice, its mean per-run cost (real or cached) times an adjustable
  research-overhead multiplier. Chains share one menu across branches, so the
  total is labelled an upper bound.

### What the analysis layer adds beyond `report.json`

- **Name fidelity.** The scorer matches names exactly (by design — fuzzy matching
  would let a model paraphrase its way to a good score), so one dropped
  apostrophe costs a miss AND a hallucination. The run detail pairs unmatched
  gold against unmatched candidate names by edit distance and splits "found but
  renamed" from "never found" — a fidelity bug and a coverage bug need different
  fixes. This is a DIAGNOSTIC OVERLAY: it never changes a scored number.
- **Page-discovery coverage.** The `fetch_page` sequence versus the pages the
  snapshot recorded, as an exact `visited / available` plus the list of pages
  never opened. A model can score well on items while never opening a whole menu
  page; that is luck, and the unvisited list is where it shows. Off-manifest
  fetches (the ordering API) are reported separately, never penalized.

  There is deliberately **no menu-page ratio**. Recognizing a menu page from its
  URL needs world knowledge a word list does not have — New York Fries serves its
  menu from `/fries`, `/poutine`, `/premiumdogs` and `/dips`, and Wooden Spoon
  from `/daily-features/`. A ratio built on menu words scored a run that opened
  only `/menu`, and skipped all five real menu pages, at a perfect 100%. The word
  list survives only as a sort hint that floats likely-relevant entries to the top
  of the unvisited list, where a miss costs a reader one extra line instead of
  producing a false number.

- **Rescore against current gold.** `report.json` is frozen at run time, so a
  later gold edit silently invalidates it. The run detail re-runs
  `scoreCandidate` over the stored `candidate.json` against today's gold and
  shows both numbers. It never rewrites `report.json` — that frozen report IS the
  historical record.
- **Unsafe tag claims.** `tag_false_positives.length` promoted to a first-class
  column: dietary tags the candidate asserted that gold does not support are the
  failure the data policy cares most about.

### Rules the aggregation obeys

These are not preferences; violating any of them produces a confidently wrong
number:

- **No composite index.** The scorer keeps recall and precision apart because
  they fail differently (a hallucinated free-of tag is a safety problem; a missed
  tag is a completeness problem). Nothing averages them into one score. Ranking
  is whichever column you sort by, and `n` sits beside every rank.
- **Absent is not zero.** Runs predate fields — 128 of the current 156 have no
  `providers`, 10 have no `wall_clock_ms` — so every optional value is
  `T | null`, and the UI renders unknown as an em dash. A failed run has no
  report and scores nothing; it is never counted as 0%.
- **Provenance splits cells.** A score measures model × provider × quantization,
  so runs served at different quantizations never share a cell.
  `quantization_requested: null` renders as "unpinned (cheapest-first)", never as
  "unquantized".
- **So do the harness, the review configuration and the prompt.** A two-pass run
  and a single-pass run of the same model are two systems, not two samples of one;
  a cheap drafter checked by a strong reviewer is a third. `review` reads `none`
  (no review pass), `same` (the reviewer inherited the primary config) or the
  override, so a drafter/reviewer split never pools with self-correction.
  `prompt_sha` closes the last silent-drift hole — and its `unknown` value means
  the prompt was not recorded, NOT that it matched the current one.
- **Averaging mode is explicit.** `macro` weights every task equally and is exact
  for every metric. `micro` pools raw counts, so a 180-item menu outweighs a
  26-item one — and it is only offered where the report carries the counts to
  pool with: item recall/precision and the per-pair accuracies. The tag and
  source metrics publish a ratio without its denominator, so micro reports **no
  value** for them rather than a weighted guess. (An earlier version did guess,
  weighting by `matched` and labelling it "approximate". Measured against the
  truth recomputed from the stored candidates, micro `tag_recall` was off by up
  to 0.25 and inverted 5% of pairwise cell comparisons — it reordered the top of
  the leaderboard. `source_recall` was optimistic in every cell by up to 0.18,
  because its real denominator is a per-task source count of 2–3 that has nothing
  to do with item count.)
- **Gold conflicts are flagged where they matter.** Different tasks naturally
  carry different `policy_version`s — that is not a conflict. Two versions of the
  SAME task's gold is, and it is badged both on a cell and in the A/B compare
  view. Note this compares version STRINGS, so it cannot see an edit made under a
  constant version (much of the corpus sits at `draft`); rescore-on-read is the
  reliable detector, since it re-runs the scorer rather than trusting a label.

- **Three empty states, never conflated.** A value; "never ran" (no runs at that
  intersection); and "ran, produced no score" (every run failed). Only the first
  is a number, and the last two are different facts — a task where half the
  configurations crashed must not read as "everything aces it, retire the task",
  which is why `taskDiscrimination` reports `n_scored_cells` beside `n_cells` and
  computes every statistic over the former.

### Layout

```
scripts/bench/prompts.ts   the model-facing prompts + promptSha (no gold, ever)
scripts/bench/harness.ts   the agent-setup registry + multi-pass accounting
scripts/bench/analyze/     pure, tested, no UI (runs under `bun test scripts`)
  record.ts     walk bench/runs -> RunRecord[]  (absent-vs-zero discipline)
  derive.ts     per-run derived metrics + the name-fidelity overlay
  aggregate.ts  cells, macro/micro averaging, spread, Pareto, task discrimination
  rescore.ts    re-run scoreCandidate against current gold (read-only)
  transcript.ts turn timeline + page-discovery coverage
  export.ts     the bench:export CLI
scripts/bench/viewer.ts    Bun.serve JSON API + static host for the SPA
bench-viewer/              the Svelte SPA (own tsconfig; dist/ is gitignored)
```

The viewer is deliberately NOT part of the main SvelteKit app: that app is
Cloudflare-bound and routes every user-facing string through the Paraglide
catalog across 27 locales, which an internal dashboard has no business paying.
