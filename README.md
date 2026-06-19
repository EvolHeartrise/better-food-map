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

Data lives in a local SQLite file at `data/food.db` (gitignored). The schema and
data-access layer are in `src/lib/server/db.ts`.

Read and write data through the **MCP server** (`scripts/db-mcp-server.ts`) — a
stdio Model Context Protocol server registered in `.mcp.json` as `food-db`. It
exposes CRUD tools (`list_locations`, `create_location`, `update_food`,
`delete_location`, `query_sql`, …) so an MCP client like Claude Code can read and
mutate the database directly via tool calls. Run it standalone with
`bun run db:mcp`. Inputs are validated with valibot, and the JSON Schema
advertised to clients is generated from those same schemas.
