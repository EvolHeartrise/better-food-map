// Entry point: a thin cache-key guard in front of the vendored PMTiles handler
// (./index, kept byte-identical to upstream — this wrapper exists so it can
// stay that way). The vendored worker caches per colo keyed on the FULL request
// URL, so without a guard two kinds of junk URL bypass the cache and trigger
// fresh R2 range reads every time:
//
//   1. query strings — /planet-x/1/2/3.mvt?anything=random is a distinct cache
//      key for the same tile, so arbitrary queries can run up R2 reads at will;
//   2. archive names — PMTILES_PATH pins every {name} to the one planet archive
//      in R2 (that is how the tile URLs carry a version token without copying
//      the ~137 GB object), which would otherwise let /any-name/1/2/3.mvt serve
//      and cache real tiles under unbounded names.
//
// So: 404 any archive name not in the ARCHIVES allowlist, and strip the query
// string before delegating so the colo cache key is canonical. The rejection is
// deliberately not edge-cached — it touches no R2 and caching junk URLs would
// itself fill the cache with junk keys.
import vendored from "./index";
import { tile_path } from "./shared";

interface Env {
	// Comma-separated archive names servable under /{name}.json and
	// /{name}/{z}/{x}/{y}.{ext} — the current version token plus any
	// transitional aliases (see wrangler.jsonc).
	ARCHIVES?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { ok, name } = tile_path(url.pathname);
		if (!ok || !(env.ARCHIVES ?? "").split(",").includes(name)) {
			return new Response("Archive not found", { status: 404 });
		}
		if (url.search) {
			url.search = "";
			request = new Request(url.toString(), request);
		}
		return vendored.fetch(request, env as Parameters<typeof vendored.fetch>[1], ctx);
	},
};
