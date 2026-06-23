## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, mcp

---

## Data policy

- **Dietary tags are source-asserted, never inferred from ingredients.** Apply a dietary tag (`vegan`, `vegetarian`, `gluten_free`, `dairy_free`, `nut_free`, `halal`) to a food item only when the source explicitly designates it — either through a dietary marker/label in the source, or when the item's name **as displayed in the source** contains that designation (e.g. a source listing "Vegan Burger", "Halal Chicken", or "Vegetarian Thali" supports the corresponding tag). Never infer a tag from the ingredient list, and never add a designation the source itself doesn't show. Removing an unsupported allergen-free tag is fine; adding a dietary tag without an explicit source designation is not.

- **Location coordinates must be OSM-based.** A location's `latitude`/`longitude` must be the exact coordinates of its matching OpenStreetMap POI from the staging store — take them verbatim from a `search_poi` candidate and pass them through `create_locations` unchanged. Never geocode from an address, hand-place a pin, round/truncate the coordinates, or copy them from a website or other source. This is what keeps `search_poi` de-duplication coordinate-exact: a venue we imported from OSM sits at distance ≈0 m from its staging POI, so true duplicates are coordinate-identical while distinct businesses (even neighbours sharing a food court) are meters apart. Geocoded coordinates break that invariant and force fuzzy proximity matching that can't tell a real duplicate from a neighbour. If a venue isn't in OSM, find/add its OSM node rather than inventing a coordinate.

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
