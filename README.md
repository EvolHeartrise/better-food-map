# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
bun x sv@0.16.1 create --template minimal --types ts --add prettier eslint mcp="ide:claude-code+setup:local" --install bun better-food-map
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Database

Data lives in a **Cloudflare D1** database (serverless SQLite). The schema is in
`migrations/0001_init.sql`; the data-access layer in `src/lib/server/db.ts` is
runtime-agnostic — every function is async and takes a D1 handle, so the same
code runs against either the Worker's `platform.env.DB` binding (the deployed
app) or the HTTP-backed client in `src/lib/server/d1-http.ts` (local tooling).

The deployed site reads D1 through its binding via the remote functions in
`src/lib/data.remote.ts`.

Read and write data through the **MCP server** (`scripts/db-mcp-server.ts`) — a
stdio Model Context Protocol server registered in `.mcp.json` as `food-db`. It
exposes CRUD tools (`list_locations`, `create_location`, `update_food`,
`delete_location`, `query_sql`, …) so an MCP client like Claude Code can read and
mutate the database directly via tool calls. It now talks to the **same
production D1** the live site reads, over the D1 REST API, so edits go live
immediately. Run it standalone with `bun run db:mcp`. It needs D1 credentials in
`.env` (see `.env.example`). Inputs are validated with valibot, and the JSON
Schema advertised to clients is generated from those same schemas.

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
```

The production D1 is already provisioned and seeded; these steps document the
one-time setup. Data is edited going forward through the MCP server.

Deploy:

- **Git-connected CI (recommended):** connect the repo in the Cloudflare
  dashboard (Workers → Builds). Build command `bun run build`, deploy via
  `wrangler deploy` (reads `wrangler.jsonc`). Note: Workers Builds does not apply
  D1 migrations — run `bun run d1:migrate` yourself when you add a migration.
- **Manual:** `bun run deploy` (builds, then `wrangler deploy`).
