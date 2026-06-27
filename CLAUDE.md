## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, mcp

---

## Data policy

- **Dietary tags are source-asserted, never inferred from ingredients.** Apply a dietary tag (`vegan`, `vegetarian`, `gluten_free`, `dairy_free`, `nut_free`, `halal`) to a food item only when the source explicitly designates it — either through a dietary marker/label in the source, or when the item's name **as displayed in the source** contains that designation (e.g. a source listing "Vegan Burger", "Halal Chicken", or "Vegetarian Thali" supports the corresponding tag). Never infer a tag from the ingredient list, and never add a designation the source itself doesn't show. Removing an unsupported allergen-free tag is fine; adding a dietary tag without an explicit source designation is not.

- **Location coordinates must be OSM-based.** A location's `latitude`/`longitude` must be the exact coordinates of its matching OpenStreetMap POI from the staging store — take them verbatim from a `search_poi` candidate and pass them through `create_locations` unchanged. Never geocode from an address, hand-place a pin, round/truncate the coordinates, or copy them from a website or other source. This is what keeps `search_poi` de-duplication coordinate-exact: a venue we imported from OSM sits at distance ≈0 m from its staging POI, so true duplicates are coordinate-identical while distinct businesses (even neighbours sharing a food court) are meters apart. Geocoded coordinates break that invariant and force fuzzy proximity matching that can't tell a real duplicate from a neighbour. If a venue isn't in OSM, find/add its OSM node rather than inventing a coordinate.

- **Addresses are STRUCTURED, not freeform.** A location stores `street`, `city`, `region` (2-letter province/state code) and `country` (ISO-2) — all required — plus an optional `postcode`. The single-line display address is DERIVED on read via `formatAddress` (`src/lib/address.ts`); it is never stored, so it is always normalized. When adding a venue, split its OSM/Overture address into these parts and pass them to `create_locations`; the MCP server normalizes `region`/`postcode`/`country` for you (e.g. "Ontario" → "ON"), so take the parts from the source — never geocode or invent them. Only the street line and postcode are the venue's own data (prefer its OSM `addr:*` tags); `city`/`region` are coarse and may come from OSM admin context. A partial postcode (e.g. a bare FSA like "T5R") is dropped rather than stored. The one-time re-derivation that backfilled existing rows lives in `scripts/backfill-address-parts.ts` (OSM tags first, then OSM Nominatim to fill gaps).

- **Ingredient tags name ONE food component — never a description.** An ingredient is a noun for a single food component (`tomato`, `cashew`, `paneer`, `soy sauce`, `coconut milk`), kept generic, reusable across menus, and **atomic** — one ingredient per comma-separated part (split "beets & cilantro" into `beets, cilantro`). **Drop cooking-method, cut/form and sourcing qualifiers down to the base component**: write `chicken`, not `grilled chicken`, `whole chicken` or `house chicken` — the dietary filter keys on _what_ the component is, not how it was cooked, cut or sourced. Transformation-defining preps that yield a distinct product (`smoked`, `pickled`, `dried`, `fermented`) and idioms (`hot sauce`, `whole wheat flour`) are the exception and stay; the fold-vs-keep boundary is recorded in `scripts/fold-classifications.json`. Never put a dish description, preparation, serving note, price, size or choice list in `ingredients` (no "served with…", "topped with…", "12 oz", "choice of milk") — prose belongs in the item `description`, and dietary/course facts in `tags`. Before authoring `ingredients`, call `search_tags` to **reuse** the established tag rather than minting a near-duplicate. Spellings are canonicalized for you on write: accents are folded deterministically (`foldIngredientName`, `src/lib/tags.ts`), and known plurals/synonyms are redirected to one canonical tag via the `ingredient_aliases` map (migration 0010), which the tag-filter search also reads so a user typing "tomatoes"/"jalapeño" finds the canonical tag. Qualifiers and conjunctions are **not** auto-stripped — instead the create/update MCP tools surface a non-blocking `warnings` array (from `ingredientProseWarning`, `src/lib/tags.ts`) flagging parts that read like a qualifier, a conjunction or prose, so you fix them at authoring time. The one-time vocabulary cleanups live in `scripts/canonicalize-ingredients.ts` (variant merge), `scripts/fold-prep-qualifiers.ts` (prep folding) and `scripts/cleanup-ingredient-tags.ts` (qualifier/conjunction/prose fold·split·delete, driven by the reviewed `scripts/ingredient-cleanup-decisions.json`).

- **A venue's menu must be EXHAUSTIVE, never a representative sample.** When you add or backfill a location's menu, capture _every_ item the source lists — across all sections (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials) and every size/variant the source itemizes — not a curated subset. Work from the most complete source available (the venue's own online-ordering menu, menu PDF, or ordering backend/API beats a photo, a Yelp blurb, or a third-party listing), and fetch the underlying ordering API or PDF when the page is JS-rendered. Exhaustive means everything the source actually shows — still never invent or pad items the source doesn't list, and still split combos/choice-lists into `optional_*` rather than prose. If the source genuinely caps what's visible (a rotating daily-bread board, a "seasonal selection"), add everything currently shown and note the cap in the item/source. Representative ~10-item samples are not acceptable.

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
