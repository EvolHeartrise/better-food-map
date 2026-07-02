## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, mcp

---

## SvelteKit conventions

- **Prefer remote functions over API routes and `load`.** Put server logic in `*.remote.ts` files using `query`/`command`/`form` from `$app/server` and call them directly from components — don't add `+server.ts` API routes or `load` functions for data the page can fetch itself. A server-only module (`$lib/server/*`) reached through a remote function never leaks into the client bundle.

- **SvelteKit config lives in `vite.config.ts`, not `svelte.config.js`.** Since `@sveltejs/kit` 2.62 the kit/compiler config is passed straight to the `sveltekit({...})` plugin, and any `svelte.config.js` is ignored — do not create one. The `kit` options (`adapter`, `experimental.remoteFunctions: true`) and `compilerOptions` (`experimental.async: true`, needed for top-level `await` in components) sit at the **top level** of the plugin options (no `kit:` wrapper). Server-only deps like `bun:sqlite` go in `ssr.external` + `optimizeDeps.exclude`.

- **Don't trust training-cutoff knowledge for Svelte/SvelteKit config — it moves fast.** Pull the latest docs via the Svelte MCP server (`list-sections` → `get-documentation`) before changing framework config, and run new Svelte components through `svelte-autofixer` until it's clean.

---

## Data policy

- **Dietary tags are source-asserted, never inferred.** Apply a dietary tag (`vegan`, `vegetarian`, `gluten_free`, `dairy_free`, `nut_free`, `halal`) to a food item only when the source explicitly designates it — either through a dietary marker/label in the source, or when the item's name **as displayed in the source** contains that designation (e.g. a source listing "Vegan Burger", "Halal Chicken", or "Vegetarian Thali" supports the corresponding tag). Never infer a tag from general knowledge of the dish, and never add a designation the source itself doesn't show. Removing an unsupported allergen-free tag is fine; adding a dietary tag without an explicit source designation is not. These six dietary tags (plus the two `course` tags, `dessert`/`drink`) are the **whole** tag vocabulary — there are no ingredient tags. The map's only menu filter is the **dietary selector** (`src/lib/components/DietSelector.svelte`): single-select over exactly these six dietary tags, and for a signed-in user the choice persists as their saved diet (`user_dietary_profile.diet`, migration 0014). An item's `optional` tag flag (`optional_tags`) marks a designation that holds only on request (e.g. "can be made vegan").

- **Location coordinates must be OSM-based.** A location's `latitude`/`longitude` must be the exact coordinates of its matching OpenStreetMap POI from the staging store — take them verbatim from a `search_poi` candidate and pass them through `create_locations` unchanged. Never geocode from an address, hand-place a pin, round/truncate the coordinates, or copy them from a website or other source. This is what keeps `search_poi` de-duplication coordinate-exact: a venue we imported from OSM sits at distance ≈0 m from its staging POI, so true duplicates are coordinate-identical while distinct businesses (even neighbours sharing a food court) are meters apart. Geocoded coordinates break that invariant and force fuzzy proximity matching that can't tell a real duplicate from a neighbour. If a venue isn't in OSM, find/add its OSM node rather than inventing a coordinate.

- **Addresses are STRUCTURED, not freeform.** A location stores `street`, `city`, `region` (2-letter province/state code) and `country` (ISO-2) — all required — plus an optional `postcode`. The single-line display address is DERIVED on read via `formatAddress` (`src/lib/address.ts`); it is never stored, so it is always normalized. When adding a venue, split its OSM/Overture address into these parts and pass them to `create_locations`; the MCP server normalizes `region`/`postcode`/`country` for you (e.g. "Ontario" → "ON"), so take the parts from the source — never geocode or invent them. Only the street line and postcode are the venue's own data (prefer its OSM `addr:*` tags); `city`/`region` are coarse and may come from OSM admin context. A partial postcode (e.g. a bare FSA like "T5R") is dropped rather than stored. The one-time re-derivation that backfilled existing rows lives in `scripts/backfill-address-parts.ts` (OSM tags first, then OSM Nominatim to fill gaps).

- **Items do not store ingredients.** Ingredient tags were removed entirely (migration 0014): an item carries only its `tags`/`optional_tags` (dietary + course), `description`, `price` and `sources`. Put any prose about what's in a dish — components, preparation, serving notes — in the item `description`, never in a structured field. There is no `ingredients` field on `create_items`/`update_items`/`create_locations` and no `search_tags` tool.

- **A venue's menu must be EXHAUSTIVE, never a representative sample.** When you add or backfill a location's menu, capture _every_ item the source lists — across all sections (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials) and every size/variant the source itemizes — not a curated subset. Work from the most complete source available (the venue's own online-ordering menu, menu PDF, or ordering backend/API beats a photo, a Yelp blurb, or a third-party listing), and fetch the underlying ordering API or PDF when the page is JS-rendered. Exhaustive means everything the source actually shows — still never invent or pad items the source doesn't list, and put a dish's options/variants the source itemizes in their own items or the `description` rather than padding. If the source genuinely caps what's visible (a rotating daily-bread board, a "seasonal selection"), add everything currently shown and note the cap in the item/source. Representative ~10-item samples are not acceptable.

---

## Data ingestion & coverage roadmap

- **Coverage goal:** fill the map outward by region — **Canada first, then the US, then other English-speaking countries.**

- **Ingestion path:** new venues come from the offline OpenStreetMap food-POI staging store (built by `bun run osm:extract`), surfaced through the `search_poi` MCP tool (already de-duplicated against existing locations) and imported with batched `create_locations`, passing each candidate's `osm_id` so coordinates and address import verbatim from OSM (see the coordinate/address policies above). The extract also stamps every POI with `admin_city`/`admin_region` from an OSM admin-boundary spatial join (`scripts/osm/enrich-admin.ts`), so an `osm_id` import can always resolve its structured address offline — never reverse-geocode by hand. **Overture Places** is the planned next ingestion feed.

- **Chains are imported with `import_chain`, not a search/create loop.** Once a chain's brand, shared regional menu and menu items exist, one `import_chain` call imports every branch in an area: it scans the staging store for the accepted source names (`name_match`, strict normalized-equality matching), drops venues already on the map, and creates each branch pointed at the shared menu with OSM-verbatim coordinates/addresses. Always run `dry_run: true` first and vet the returned `name_buckets` (every name seen, with counts and matched/unmatched) before importing; re-runs are safe since imported branches are excluded. After any bulk import, run `audit_locations` with `check: "duplicate_locations"` — OSM occasionally carries two stale nodes for one venue (metres apart), which coordinate-exact dedup cannot catch; verify each flagged pair against the venue's own store locator before `delete_location`.

- **Permanently-closed venues are recorded, never silently skipped.** OSM staging data is stale, so a fraction of `search_poi` candidates are venues that have since closed. Two layers keep them from wasting research time: (1) `osm:extract` drops POIs OSM itself marks closed (`disused=yes`/`opening_hours=off`/lifecycle-prefixed tags — `isClosed` in `scripts/osm/map-feature.ts`); (2) for a venue that's still live-tagged in OSM but you **verify** is closed (Yelp/Google "permanently closed", dead site, closure notice), record it instead of moving on — a closed record is hidden from the map but still blocks re-suggestion and re-creation, so it never costs research time again. **Check open/closed BEFORE researching a full menu.** When adding a venue **not yet on the map** that you confirm is closed, call `create_locations` with a `closed_reason` (the evidence) and **no** `menu_items` — a born-closed tombstone. When a venue **already on the map** closes, call `close_location` (id + reason) — a soft-delete that **preserves the venue's user likes** for analysis; never `delete_location` a real venue that has likes/history (delete is only for a mistaken/duplicate row). Reopen with `close_location … reopen: true`. Soft-delete lives on `locations.closed_at`/`closed_reason` (migration 0015).

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
