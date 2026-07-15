# BetterFoodMaps

An interactive map of food venues — [betterfoodmaps.com](https://betterfoodmaps.com).
Browse restaurants, cafés and bakeries on a world map, search venues and menu
items together, and filter every menu by diet (vegan, vegetarian, gluten-free,
dairy-free, nut-free, halal). Built with SvelteKit (Svelte 5) on Cloudflare
Workers, with the data in Cloudflare D1 and the map rendered by MapLibre GL.

The map is public at the root `/` — the zoomed-out globe shows a landing overlay
with coverage stats (`src/lib/components/MapStatsOverlay.svelte`) until you zoom
in or hit "start". Signing in (Google) is optional and adds likes and a saved
diet.

To recreate the original scaffolding this project started from:

```sh
bun x sv@0.16.1 create --template minimal --types ts --add prettier eslint mcp="ide:claude-code+setup:local" --install bun better-food-map
```

## Developing

Install dependencies with `bun install`, then start a development server:

```sh
bun run dev

# or start the server and open the app in a new browser tab
bun run dev -- --open
```

The dev server runs on port **5050** (set in `vite.config.ts` — the Google OAuth
callback URI is derived from it, so don't change it casually).

## Building

To create a production version of the app:

```sh
bun run build
```

You can preview the production build with `bun run preview`. Tests live next to
the scripts they cover; run them with `bun test scripts`.

## Database

Data lives in a **Cloudflare D1** database (serverless SQLite). The schema
evolves through the numbered files in `migrations/` (0001–0017): `0001` is the
initial schema, `0002`/`0004` add and then unify the chain model (brands, shared
menus, one `items` table), `0007` adds users/sessions/likes, `0008`/`0009` split
addresses into structured parts, `0011` adds per-menu currency, `0012` requires
`menus.last_verified`, `0013`/`0014` add then simplify the user dietary profile
(and drop ingredient tags + search history), `0015` adds soft-delete for
permanently closed venues, `0016` adds FTS5 trigram search mirrors for venue and
item names, and `0017` indexes session expiry for the purge sweep. The data-access layer in `src/lib/server/db.ts` is
runtime-agnostic — every function is async and takes a D1 handle, so the same
code runs against either the Worker's `platform.env.DB` binding (the deployed
app) or the HTTP-backed client in `src/lib/server/d1-http.ts` (local tooling).

The deployed site reads D1 through its binding via the remote functions in
`src/lib/data.remote.ts`.

Read and write data through the **MCP server** (`scripts/db-mcp-server.ts`) — a
stdio Model Context Protocol server registered in `.mcp.json` as `food-db`. It
exposes CRUD tools over locations, brands, menus and items (`list_locations`,
`create_locations`, `update_items`, `close_location`, …) plus the OSM tools
`search_poi` and `audit_locations`, so an MCP client like Claude Code can read
and mutate the database directly via tool calls. It talks to the **same
production D1** the live site reads, over the D1 REST API, so edits go live
immediately. Run it standalone with `bun run db:mcp`. It needs D1 credentials in
`.env` (see `.env.example`). Inputs are validated with valibot, and the JSON
Schema advertised to clients is generated from those same schemas.

## Finding new locations (OpenStreetMap)

To add venues at scale we pull candidates from **OpenStreetMap** instead of
hitting rate-limited public Overpass mirrors. A one-time extract builds a small,
local **food-POI staging store** (SQLite under `data/`, gitignored and
disposable — only curated rows ever reach D1), and the MCP server's `search_poi`
tool reads it offline.

One-time tool install (the extract shells out to `osmium`):

```sh
# Debian/Ubuntu
sudo apt-get install osmium-tool
# macOS
brew install osmium-tool
```

Build / refresh the store for a region (download extracts from
[Geofabrik](https://download.geofabrik.de/)):

```sh
# e.g. Canada — re-running --region canada replaces just that region's rows
bun run osm:extract --region canada --input canada-latest.osm.pbf
```

This filters the extract to food POIs only (`amenity=restaurant,cafe,fast_food,
bar,pub,…` and `shop=bakery,…`), so the store stays small (single-digit MB for a
province, low-GB even continent-wide) regardless of the source extract's size.
It also fills in missing addresses from the addressed OSM building each POI sits
in; `bun run overture:enrich` can fill remaining gaps from an Overture Maps
places cache (addresses only — coordinates always stay OSM). Override the DB
path with `--db` or the `OSM_POI_DB` env var.

Then, in an MCP client, discover venues still missing from the map:

- `search_poi` takes a centre (`latitude` + `longitude` + `radius_km`) or a
  `bbox`. By default it omits POIs already in D1 (de-duplicated by proximity +
  name), so you only see what's missing.
- Each candidate carries an `osm_id` and `osm_url`, a `suggested_category`,
  structured `address_parts`, and OSM contact/cuisine/opening-hours fields. Add
  them in batches with `create_locations`, passing each candidate's `osm_id` —
  the coordinates and address then import verbatim from OSM and the `osm_url` is
  cited automatically.
- `diet_markers` are venue-level OSM `diet:*` markers — informational only;
  per-item dietary tags stay source-asserted (see the data policy in CLAUDE.md).
- `audit_locations` checks existing rows against the staging store (coordinate
  drift, missing addresses) and returns a work-list to fix with
  `update_locations`.

The store is regenerable, so refresh a region any time by re-running the
extract; Geofabrik updates daily.

## Accounts & sign-in (Google OAuth)

**The map is public — sign-in is optional.** The map lives at the root `/`
(`src/routes/+page.svelte`); there is no navigation gate (see the hook chain in
`src/hooks.server.ts`: just a canonical-host redirect and session resolution).
Selecting a venue updates the address bar to `/locations/<id>` via shallow
routing; there is no real route at that path, so the `reroute` hook in
`src/hooks.ts` maps shared/refreshed deep links back onto the map page, which
reads the id from the URL and opens the detail panel.

Signing in adds the user-owned features: **liking** locations and menu items
(`src/lib/user.remote.ts`) and a **saved diet** — the dietary selector's choice
persists as a single dietary tag in `user_dietary_profile.diet` and is
pre-applied as the map's filter on the next visit (`src/lib/profile.remote.ts`).
These remote functions guard themselves with `requireUser()`; the map data reads
in `src/lib/data.remote.ts` are public. Sign-in is **Google OAuth only** (no
passwords), implemented directly with [Arctic](https://arcticjs.dev):

- `src/lib/server/oauth.ts` builds the Google client; `src/routes/auth/login/google`
  starts the flow and `src/routes/auth/callback/google` completes it. The login route
  stashes the validated `redirectTo` (see `src/lib/redirect.ts`) in a short-lived
  cookie that the callback reads to land the user back where they started.
- Sessions are **database-backed** (`sessions` table). The cookie holds an opaque
  token whose SHA-256 hash is the row key, so the raw token is never stored
  (`src/lib/server/auth.ts`). The `authenticate` hook in `src/hooks.server.ts`
  resolves it into `locals.user` on every request.
- User-owned data lives in the tables added by
  `migrations/0007_users_likes_searches.sql` (`users`, `oauth_accounts`,
  `sessions` — the `search_history` table it also created was dropped by migration
  0014, and its `liked_locations`/`liked_items` were replaced by migration 0029's
  bookmarks + ratings) plus `user_dietary_profile` (migrations 0013/0014) and the
  review system (`migrations/0029_reviews.sql`: `location_bookmarks`,
  `item_bookmarks`, `location_reviews`, `item_reviews`, and their report tables).

It needs two secrets — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — from a
Google Cloud **OAuth 2.0 Client** of type "Web application". Register these
authorized redirect URIs on it:

- `https://betterfoodmaps.com/auth/callback/google` (production)
- `http://localhost:5050/auth/callback/google` (local `vite dev`)

**Local dev:** copy `.dev.vars.example` to `.dev.vars` and fill the two values —
the Cloudflare adapter loads them into `platform.env` during `vite dev`.

**Production:** set them as Worker secrets:

```sh
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
```

## Deploying to Cloudflare

The app deploys to **Cloudflare Workers** (Static Assets) via
`@sveltejs/adapter-cloudflare`; config is in `wrangler.jsonc`.

One-time setup:

```sh
# 1. Authenticate wrangler (interactive — run yourself):
#    bunx wrangler login

# 2. Create the D1 database, then paste the printed database_id into
#    wrangler.jsonc (d1_databases[0].database_id):
bunx wrangler d1 create better-food-map

# 3. Create the schema (and seed the canonical tags) on the remote D1:
bun run d1:migrate            # wrangler d1 migrations apply … --remote

# 4. Copy .env.example to .env and fill in CLOUDFLARE_ACCOUNT_ID,
#    CLOUDFLARE_DATABASE_ID, and a CLOUDFLARE_API_TOKEN (D1 Edit permission).

# 5. Set the Google OAuth secrets (see "Accounts & sign-in" above):
#    bunx wrangler secret put GOOGLE_CLIENT_ID
#    bunx wrangler secret put GOOGLE_CLIENT_SECRET
```

The production D1 is already provisioned and seeded; these steps document the
one-time setup. Data is edited going forward through the MCP server.

Deploy:

- **Git-connected CI (the canonical path):** the repo is connected in the
  Cloudflare dashboard (Workers → Builds); every push to `main` builds with
  `bun run build` and deploys via `wrangler deploy` (reads `wrangler.jsonc`).
  Note: Workers Builds does **not** apply D1 migrations — run
  `bun run d1:migrate` yourself when you add a migration.
- **Manual:** `bun run deploy` (builds, then `wrangler deploy`). Requires a
  valid local `wrangler login`; prefer the CI path.
