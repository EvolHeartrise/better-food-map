# better-food-map-tiles

Self-hosted basemap tile server: the official [PMTiles Cloudflare Worker](https://github.com/protomaps/PMTiles/tree/main/serverless/cloudflare) (vendored byte-identical under `src/index.ts` + `src/shared.ts`), serving the Protomaps `planet.pmtiles` archive out of the `better-food-map-tiles` R2 bucket via ranged reads. The actual entry point is `src/worker.ts`, a thin guard in front of the vendored handler: it 404s archive names outside the `ARCHIVES` allowlist, requires the one canonical spelling of each tile path (the upstream URL regex is loose — leading zeros, any extension), strips query strings, and returns error responses `no-store` (evicting them from the colo cache) so a transient failure can't get pinned under the year-long immutable `CACHE_CONTROL`. Details in its header comment.

Endpoints (on `tiles.betterfoodmaps.com`, for each name in `ARCHIVES` — currently `planet-2026-07-09` plus the legacy `planet` alias):

- `/{name}.json` — TileJSON (tile URL template, zoom range, bounds)
- `/{name}/{z}/{x}/{y}.mvt` — vector tiles

The archive `{name}` is a **version token, not an R2 object key**: `PMTILES_PATH` maps every allowed name onto the single `planet.pmtiles` object. Responses are cached immutable for a year (`CACHE_CONTROL`), and a data refresh rolls the cache by bumping the token instead of purging (we hold no cache-purge-capable token).

The app's map style (`TILE_ARCHIVE` in `src/lib/components/LocationMap.svelte` at the repo root) inlines the versioned tile URL template directly — it does not fetch the TileJSON, which would cost a serial round trip before the first tile on the map's LCP path.

`ALLOWED_ORIGINS` (CORS) includes the mobile app's WebView origins — `capacitor://localhost` (iOS) and `https://localhost` (Android) — alongside the production site and `http://localhost:5050` (vite dev), so the Capacitor app's map fetches tiles too. This Worker is **deployed manually** (see below), so an origin change here only takes effect on the next manual deploy — it does not ride the app's CI.

## Refreshing the planet archive

1. Upload the new Protomaps build over `planet.pmtiles` in the `better-food-map-tiles` bucket (multipart upload replaces the object atomically; see the aria2 + rclone notes from the original migration). In-flight range reads against the old object are protected by the PMTiles etag guard. **Never delete-then-upload**: a window with the key missing serves 404s (returned `no-store` and evicted by the guard, so it self-heals — but it's still an outage).
2. Bump the version token in **both** places: `ARCHIVES` here (`wrangler.jsonc`) and `TILE_ARCHIVE` in `src/lib/components/LocationMap.svelte`, e.g. to `planet-YYYY-MM-DD` matching the new build's date. Do 1 → 2 promptly: between the upload and the app deploy, cache misses under the **old** token serve new-build tiles next to cached old-build ones — live sessions see old/new seams, and those new-build tiles stay pinned under the old token until it is dropped. (If that gap ever matters, the durable fix is per-token R2 objects: upload each build as `{token}.pmtiles` and set `PMTILES_PATH` to `{name}.pmtiles`, at the cost of temporarily storing two planets.)
3. Keep the previous token in `ARCHIVES` while sessions loaded before the app deploy are still alive (they keep requesting it), then drop it — a dropped token 404s (uncached) instead of serving mixed-age tiles out of the edge cache.
4. Deploy this Worker (below) **before** the app change deploys, so the new URLs are live when clients start requesting them. Getting the order wrong is safe but wasteful: the guard 404s unknown tokens **without caching the 404**, so a too-early request self-heals once the Worker deploys (whereas the pre-guard code edge-cached such 404s for a day — the reason a token, once burned by an early request, is bumped rather than reused).

## Deploy

This Worker is deployed manually, not by the repo's CI (Workers Builds only builds the app Worker). The repo `.env` carries a D1-scoped `CLOUDFLARE_API_TOKEN` that cannot deploy Workers, so the deploy must run with wrangler's OAuth login instead — strip the token from the environment:

```sh
cd workers/tiles && bun install && env -u CLOUDFLARE_API_TOKEN bunx wrangler deploy
```

The custom domain `tiles.betterfoodmaps.com` is declared as a `custom_domain` route in `wrangler.jsonc`, so the deploy attaches it (and its DNS record) automatically; `workers_dev` is disabled, so that domain is the Worker's only address.
