# better-food-map-tiles

Self-hosted basemap tile server: the official [PMTiles Cloudflare Worker](https://github.com/protomaps/PMTiles/tree/main/serverless/cloudflare) (vendored under `src/`), serving the Protomaps `planet.pmtiles` archive out of the `better-food-map-tiles` R2 bucket via ranged reads.

Endpoints (on `tiles.betterfoodmaps.com`):

- `/planet.json` — TileJSON (tile URL template, zoom range, bounds)
- `/planet/{z}/{x}/{y}.mvt` — vector tiles

The app's map style (`src/lib/components/LocationMap.svelte` at the repo root) points at the TileJSON URL.

## Deploy

This Worker is deployed manually, not by the repo's CI (Workers Builds only builds the app Worker). The repo `.env` carries a D1-scoped `CLOUDFLARE_API_TOKEN` that cannot deploy Workers, so the deploy must run with wrangler's OAuth login instead — strip the token from the environment:

```sh
cd workers/tiles && bun install && env -u CLOUDFLARE_API_TOKEN bunx wrangler deploy
```

The custom domain `tiles.betterfoodmaps.com` is declared as a `custom_domain` route in `wrangler.jsonc`, so the deploy attaches it (and its DNS record) automatically; `workers_dev` is disabled, so that domain is the Worker's only address.
