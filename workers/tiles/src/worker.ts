// Entry point: a thin cache guard in front of the vendored PMTiles handler
// (./index, kept byte-identical to upstream — this wrapper exists so it can
// stay that way). The vendored worker edge-caches per colo keyed on the FULL
// request URL and stamps EVERY response — errors included — with the long
// immutable CACHE_CONTROL, so without a guard junk URLs fragment the cache
// into fresh R2 range reads, and a transient error gets pinned for a year.
// Three guards, in order:
//
//   1. archive-name allowlist — PMTILES_PATH pins every {name} to the one
//      planet archive in R2 (that is how the tile URLs carry a version token
//      without copying the ~137 GB object), which would otherwise let
//      /any-name/1/2/3.mvt serve and cache real tiles under unbounded names.
//      The 404 is deliberately not edge-cached: it touches no R2, and caching
//      junk URLs would itself fill the cache with junk keys.
//   2. canonical-URL check — the upstream TILE regex is loose (leading-zero
//      z/x/y, any character where the extension dot goes, any [a-z]+ ext),
//      so one real tile is reachable under unbounded spellings, each a
//      distinct cache key costing its own R2 read. Rebuilding the one
//      canonical path from the parse and requiring equality (plus stripping
//      query strings) collapses them: exactly one cacheable URL per tile.
//   3. error responses are returned no-store and evicted from the colo
//      cache — the vendored handler has already cache.put them with the
//      year-long CACHE_CONTROL, under which one transient blip (say a
//      mid-refresh R2 miss) would poison every touched tile URL in browsers
//      (unfixable remotely) and colos until the version token is burned.
//      The delete races the vendored waitUntil(cache.put), so a poisoned
//      entry may survive this request — but then the next request for it
//      re-runs this eviction after the put has settled, so it converges.
//      Tiles, TileJSON and empty-tile 204s keep the immutable caching.
import vendored from "./index";
import { tile_path } from "./shared";

interface Env {
	// Comma-separated archive names servable under /{name}.json and
	// /{name}/{z}/{x}/{y}.mvt — the current version token plus any
	// transitional aliases (see wrangler.jsonc).
	ARCHIVES?: string;
	// Comma-separated exact-match CORS allowlist consumed by the vendored
	// handler (see wrangler.jsonc). Declared here because the dev-origin
	// reflection below appends to it per-request.
	ALLOWED_ORIGINS?: string;
}

// Local dev servers run on arbitrary ports (vite picks 5050 by default here,
// but --port anything must work), so instead of pinning one port in
// ALLOWED_ORIGINS we reflect any plain-http loopback origin into the
// allowlist for this request and let the vendored exact-match logic accept
// it. Loopback-only and http-only, so no deployed site can match; production
// origins never hit this branch, keeping their responses byte-identical.
// Cache-safe: the vendored handler stamps `Vary: Origin` on every response
// (the front Workers Cache keys variants per origin), and its internal
// caches.default entries store no Access-Control-Allow-Origin at all — the
// header is re-derived per request after the cache match.
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { ok, name, tile } = tile_path(url.pathname);
		const archives = (env.ARCHIVES ?? "").split(",").map((a) => a.trim());
		const canonical = tile ? `/${name}/${tile[0]}/${tile[1]}/${tile[2]}.mvt` : `/${name}.json`;
		if (!ok || !archives.includes(name) || url.pathname !== canonical) {
			return new Response("Archive not found", { status: 404 });
		}
		if (url.search) {
			url.search = "";
			request = new Request(url.toString(), request);
		}
		const origin = request.headers.get("Origin");
		if (origin && DEV_ORIGIN.test(origin) && !(env.ALLOWED_ORIGINS ?? "").split(",").includes(origin)) {
			env = { ...env, ALLOWED_ORIGINS: [env.ALLOWED_ORIGINS, origin].filter(Boolean).join(",") };
		}
		const resp = await vendored.fetch(request, env as Parameters<typeof vendored.fetch>[1], ctx);
		if (resp.status >= 400) {
			ctx.waitUntil(caches.default.delete(url.toString()));
			const uncached = new Response(resp.body, resp);
			uncached.headers.set("Cache-Control", "no-store");
			return uncached;
		}
		return resp;
	},
};
