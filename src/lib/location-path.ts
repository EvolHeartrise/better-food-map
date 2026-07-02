// The id embedded in a synthetic `/locations/<id>` URL, or null when the path
// isn't one. `/locations/<id>` is not a real route: the `reroute` hook
// (src/hooks.ts) serves the root map page for it, and both that page
// (+page.svelte, to open the venue detail) and its server load
// (+page.server.ts, to 404 unknown/closed ids) recover the id from the same
// pathname — through this ONE helper, so the two can never disagree on what
// counts as a venue URL. Client-safe by design: the map page imports it into
// the browser bundle.
//
// The id must be the path's TRAILING segment — the bare map `/`, a trailing
// slash, or extra segments all yield null (and thus the plain map view).
// Malformed percent-encoding throws (decodeURIComponent's URIError) — in
// practice unreachable, since SvelteKit 400s undecodable paths before routing,
// but the server load still maps a throw to a 404 as belt-and-braces.
export function idFromPath(pathname: string): string | null {
	const match = pathname.match(/\/locations\/([^/]+)$/);
	return match ? decodeURIComponent(match[1]) : null;
}
