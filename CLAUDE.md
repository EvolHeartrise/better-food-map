## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, mcp

---

## SvelteKit conventions

- **Prefer remote functions over API routes and `load`.** Put server logic in `*.remote.ts` files using `query`/`command`/`form` from `$app/server` and call them directly from components — don't add `+server.ts` API routes or `load` functions for data the page can fetch itself. A server-only module (`$lib/server/*`) reached through a remote function never leaks into the client bundle.

- **SvelteKit config lives in `vite.config.ts`, not `svelte.config.js`.** Since `@sveltejs/kit` 2.62 the kit/compiler config is passed straight to the `sveltekit({...})` plugin, and any `svelte.config.js` is ignored — do not create one. The `kit` options (`adapter`, `experimental.remoteFunctions: true`) and `compilerOptions` (`experimental.async: true`, needed for top-level `await` in components) sit at the **top level** of the plugin options (no `kit:` wrapper). Server-only deps like `bun:sqlite` go in `ssr.external` + `optimizeDeps.exclude`.

- **Don't trust training-cutoff knowledge for Svelte/SvelteKit config — it moves fast.** Pull the latest docs via the Svelte MCP server (`list-sections` → `get-documentation`) before changing framework config, and run new Svelte components through `svelte-autofixer` until it's clean.

- **User-facing strings live in the message catalog, never as literals.** Every string a user can see — in components, `+error.svelte`/`<svelte:head>`, remote functions, `+page.server.ts` loads and `+server.ts` endpoints — goes in `messages/en.json` + `messages/fr.json` (keep the key sets identical) and is called via `import { m } from '$lib/paraglide/messages'` (`m.*()` and `getLocale()` resolve the caller's locale server-side too, per the `localize` hook). DB content (venue/item names, descriptions, addresses) and tag/category ids are data, not UI copy — never translate them. Internal/dev-facing errors (valibot `v.check`, `db-write.ts`, sitemap 404) stay English. The public browse tree (`/[country]/…`, `/places`) and the sitemaps are a deliberate English **crawl surface**: they send `Cache-Control: public`, so the `localize` hook (`isPublicEnglishSurface`) pins them to the base locale — a per-request locale on a shared-cached response would be edge-cached from the first visitor and served to everyone, crawlers included, as the wrong `<html lang>` over English content.

---

## Data policy

- **Dietary tags are source-asserted, never inferred; course tags are factual and mandatory.** Apply a dietary tag (`vegan`, `vegetarian`, `gluten_free`, `dairy_free`, `nut_free`, `halal`) to a food item only when the source explicitly designates it — either through a dietary marker/label in the source, or when the item's name **as displayed in the source** contains that designation (e.g. a source listing "Vegan Burger", "Halal Chicken", or "Vegetarian Thali" supports the corresponding tag). Never infer a tag from general knowledge of the dish, and never add a designation the source itself doesn't show. Removing an unsupported allergen-free tag is fine; adding a dietary tag without an explicit source designation is not. These six dietary tags plus three `course` tags (`food`, `dessert`, `drink`) are the **whole** tag vocabulary — there are no ingredient tags. Course tags are the opposite of source-asserted: every item **requires** at least one, applied factually — `food` explicitly marks an item as neither dessert nor drink (so an item with no course tag at all means "never course-reviewed", not "food"), `dessert`/`drink` may combine on one item when it's genuinely both (a milkshake), but `food` never combines with either; when a source doesn't sort an item's course cleanly, tie-break on the source menu's own section placement ("Desserts", "Drinks", …), or on what the item is served as when the source is unsectioned. Course tags can never live in `optional_tags`. The pre-mandate item backlog is drained gradually via `audit_locations` (check: `missing_course_tag`, paged). The map's only menu filter is the **dietary selector** (`src/lib/components/DietSelector.svelte`): single-select over exactly the six dietary tags, and for a signed-in user the choice persists as their saved diet (`user_dietary_profile.diet`, migration 0014). An item's `optional` tag flag (`optional_tags`) marks a designation that holds only on request (e.g. "can be made vegan").

- **Location coordinates must be OSM-based.** A location's `latitude`/`longitude` must be the exact coordinates of its matching OpenStreetMap POI from the staging store — take them verbatim from a `search_poi` candidate and pass them through `create_locations` unchanged. Never geocode from an address, hand-place a pin, round/truncate the coordinates, or copy them from a website or other source. This is what keeps `search_poi` de-duplication coordinate-exact: a venue we imported from OSM sits at distance ≈0 m from its staging POI, so true duplicates are coordinate-identical while distinct businesses (even neighbours sharing a food court) are meters apart. Geocoded coordinates break that invariant and force fuzzy proximity matching that can't tell a real duplicate from a neighbour. If a venue isn't in OSM, find/add its OSM node rather than inventing a coordinate.

- **Addresses are STRUCTURED, not freeform.** A location stores `street`, `city`, `region` (2-letter province/state code) and `country` (ISO-2) — all required — plus an optional `postcode`. The single-line display address is DERIVED on read via `formatAddress` (`src/lib/address.ts`); it is never stored, so it is always normalized. When adding a venue, split its OSM/Overture address into these parts and pass them to `create_locations`; the MCP server normalizes `region`/`postcode`/`country` for you (e.g. "Ontario" → "ON"), so take the parts from the source — never geocode or invent them. Only the street line and postcode are the venue's own data (prefer its OSM `addr:*` tags); `city`/`region` are coarse and may come from OSM admin context. A partial postcode (e.g. a bare FSA like "T5R") is dropped rather than stored.

- **Items do not store ingredients.** Ingredient tags were removed entirely (migration 0014): an item carries only its `tags`/`optional_tags` (dietary + course), `description`, `price` and `sources`. Put any prose about what's in a dish — components, preparation, serving notes — in the item `description`, never in a structured field. There is no `ingredients` field on `create_items`/`update_items`/`create_locations` and no `search_tags` tool.

- **A venue's menu must be EXHAUSTIVE, never a representative sample.** When you add or backfill a location's menu, capture _every_ item the source lists — across all sections (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials) and every size/variant the source itemizes — not a curated subset. Work from the most complete source available (the venue's own online-ordering menu, menu PDF, or ordering backend/API beats a photo, a Yelp blurb, or a third-party listing), and fetch the underlying ordering API or PDF when the page is JS-rendered. Exhaustive means everything the source actually shows — still never invent or pad items the source doesn't list, and put a dish's options/variants the source itemizes in their own items or the `description` rather than padding. If the source genuinely caps what's visible (a rotating daily-bread board, a "seasonal selection"), add everything currently shown and note the cap in the item/source. Representative ~10-item samples are not acceptable.

---

## Data ingestion & coverage roadmap

- **Coverage goal:** fill the map outward by region — **Canada first, then the US, then other English-speaking countries.**

- **Ingestion path:** new venues come from the offline OpenStreetMap food-POI staging store (built by `bun run osm:extract`), surfaced through the `search_poi` MCP tool (already de-duplicated against existing locations) and imported with batched `create_locations`, passing each candidate's `osm_id` so coordinates and address import verbatim from OSM (see the coordinate/address policies above). The extract also stamps every POI with `admin_city`/`admin_region` from an OSM admin-boundary spatial join (`scripts/osm/enrich-admin.ts`), so an `osm_id` import can always resolve its structured address offline — never reverse-geocode by hand. **Overture Places** is the planned next ingestion feed.

- **Chains are imported with `import_chain`, not a search/create loop.** Once a chain's brand, shared regional menu and menu items exist, one `import_chain` call imports every branch in an area: it scans the staging store for the accepted source names (`name_match`, strict normalized-equality matching), drops venues already on the map, and creates each branch pointed at the shared menu with OSM-verbatim coordinates/addresses. Pass `country` (e.g. `"CA"`) on country-scale imports — the Canada extract carries some US border-town POIs that would otherwise surface — and pass the chain's `brand_wikidata` QID (read it off the main bucket's annotation in the dry run) to auto-accept variant names carrying the chain's own OSM brand tag; a brand-tagged POI whose name _conflicts_ is a known mistag pattern and stays out, and a co-branded unit name ("Wendy's / Tim Hortons") is never absorbed into a single chain — vet those buckets by hand. Always run `dry_run: true` first and vet the returned `name_buckets` (every name seen, with counts, matched/unmatched — buckets accepted via the QID are flagged `matched_via_brand` — and its dominant `brand:wikidata`) before importing; re-runs are safe since imported branches are excluded. After any bulk import, run `audit_locations` with `check: "duplicate_locations"` — OSM occasionally carries two stale nodes for one venue (metres apart), which coordinate-exact dedup cannot catch; verify each flagged pair against the venue's own store locator, then either `delete_locations` the redundant row or record a confirmed two-real-venues pair with `mark_not_duplicate` (evidence in `reason`) so it is suppressed from every future audit instead of being re-verified forever.

- **Verify menu research in proportion to source risk, not flat-rate.** A menu extracted from one machine-readable official feed (ordering-API JSON, nutrition PDF) needs only a spot-check of its dietary-tagged items against that same feed plus a section-completeness pass; reserve full item-by-item adversarial re-verification for menus assembled from scattered HTML pages or with many dietary tags relative to the source's clarity. Always check the same source FORMAT the researcher cited — dietary markers often live in a structured feed, not the rendered HTML — and when a tag stays uncertain, strip it (the source-asserted policy above).

- **Bank how to refresh a menu on the menu row (`refresh_notes`).** Re-verifying a chain menu is dominated by re-discovering how to read its source — the ordering API behind a client-rendered page, the nutrition-PDF path, fetch caveats. Record that in the menu's `refresh_notes` (create_menu/update_menu) the moment research discovers it, and read it back (get_menu) before re-researching any menu from scratch.

- **Keep a menu's `sources` FEW and user-friendly — provenance, not a scrape log.** A menu's sources are the handful of links a human opens to trust its food data, shown behind the venue panel's "N Sources" button. Cite the canonical browsable pages (usually 1–3): the official menu / nutrition / allergen page, plus at most one aggregator (Uber Eats/DoorDash) or a nutrition PDF when it corroborates something the official page lacks. **Never cite one URL per item, and never cite a raw API/ordering endpoint** (`…/api/…`, `…/apiproxy/…`, `?fuseaction=order`) — per-item and API links read as noise and build no trust. When the menu data comes from a JSON/ordering feed behind a JS-rendered page, cite the public page a reader can open and bank the feed endpoint in `refresh_notes` instead (the API is how you RE-FETCH, not how a reader VERIFIES). Use `update_menu`'s `sources` (replace) to slim an over-cited menu.

- **Permanently-closed venues are recorded, never silently skipped.** OSM staging data is stale, so a fraction of `search_poi` candidates are venues that have since closed. Two layers keep them from wasting research time: (1) `osm:extract` drops POIs OSM itself marks closed (`disused=yes`/`opening_hours=off`/lifecycle-prefixed tags — `isClosed` in `scripts/osm/map-feature.ts`); (2) for a venue that's still live-tagged in OSM but you **verify** is closed (Yelp/Google "permanently closed", dead site, closure notice), record it instead of moving on — a closed record is hidden from the map but still blocks re-suggestion and re-creation, so it never costs research time again. **Check open/closed BEFORE researching a full menu.** When adding a venue **not yet on the map** that you confirm is closed, call `create_locations` with a `closed_reason` (the evidence) and **no** `menu_items` — a born-closed tombstone. When a venue **already on the map** closes, call `close_location` (id + reason) — a soft-delete that **preserves the venue's user likes** for analysis; never `delete_locations` a real venue that has likes/history (delete is only for a mistaken/duplicate row). Reopen with `close_location … reopen: true`. Soft-delete lives on `locations.closed_at`/`closed_reason` (migration 0015).

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
