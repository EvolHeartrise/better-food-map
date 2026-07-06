import { slugify } from './text';

// The `/locations/<…>` synthetic URL and the helpers that mint and parse it.
// `/locations/<id>` is not a real route: the `reroute` hook (src/hooks.ts)
// serves the root map page for it, and both that page (+page.svelte, to open the
// venue detail) and its server load (+page.server.ts, to 404 unknown/closed ids
// and 301 non-canonical ones) recover the id from the pathname through the ONE
// parser below, so the two can never disagree on what counts as a venue URL.
// Client-safe by design: the map page imports these into the browser bundle.

/**
 * An RFC-4122 UUID anchored to the END of a string. Location ids minted by the
 * app are UUIDs (crypto.randomUUID), so a descriptive URL is `<slug>-<uuid>`
 * with the id as the trailing UUID; matching it back out is how {@link idFromPath}
 * recovers the id from a slugged path. The `i` flag tolerates an upper-cased UUID
 * a crawler might have mangled; the `$` anchor means the id is always the LAST
 * UUID, so a name whose slug coincidentally contains a UUID-shaped run can't fool
 * the parser.
 */
const TRAILING_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id embedded in a `/locations/<…>` URL, or null when the path isn't one.
 *
 * The id must live in the path's TRAILING segment — the bare map `/`, a trailing
 * slash, or extra segments all yield null (and thus the plain map view). Within
 * that segment the id is recovered two ways:
 *   • `<name-slug>-<uuid>` (the canonical descriptive form) or a bare `<uuid>` →
 *     the trailing UUID is the id;
 *   • anything else (a legacy short-slug id like `wr-damianos`, which never gets
 *     a descriptive prefix — see {@link locationSlug}) → the whole segment is the
 *     id. So a bare `/locations/<legacy-id>` link still resolves.
 *
 * Malformed percent-encoding throws (decodeURIComponent's URIError) — in
 * practice unreachable, since SvelteKit 400s undecodable paths before routing,
 * but the server load still maps a throw to a 404 as belt-and-braces.
 */
export function idFromPath(pathname: string): string | null {
	const match = pathname.match(/\/locations\/([^/]+)$/);
	if (!match) return null;
	const segment = decodeURIComponent(match[1]);
	const uuid = TRAILING_UUID.exec(segment);
	return uuid ? uuid[0] : segment;
}

/** The minimal identity a descriptive slug is built from: the venue's name, its
 *  city (both fold into the human-readable prefix) and its id (the identity the
 *  parser recovers). */
export interface Sluggable {
	id: string;
	name: string;
	city: string;
}

/** Matches an id that is itself a whole UUID (the app-minted id format). */
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical trailing segment for a venue URL: `<name>-<city>-<uuid>` for the
 * app's UUID ids (e.g. `prado-cafe-vancouver-fe0e…`), so the URL carries keyword
 * signal while the trailing UUID stays parseable by {@link idFromPath}. A legacy
 * short-slug id (the ~20 seed venues whose id is not a UUID) gets NO descriptive
 * prefix — its id isn't a trailing UUID, so a prefixed form would be unparseable;
 * its bare id is already a readable slug. If the name+city produce no slug at all
 * (pure punctuation), the bare id is the fallback.
 */
export function locationSlug(location: Sluggable): string {
	// The id is percent-encoded so the path stays URL-safe whatever the id holds;
	// for the real id shapes (a UUID, or a `wr-*` short slug) every character is
	// already unreserved, so this is a no-op and the id reads verbatim. idFromPath
	// decodes the whole segment back, so the round-trip is exact.
	const id = encodeURIComponent(location.id);
	if (!IS_UUID.test(location.id)) return id;
	// The slug prefix comes straight from slugify, which emits only [a-z0-9-], so
	// it never needs encoding — its hyphens stay readable.
	const prefix = slugify(`${location.name} ${location.city}`);
	return prefix ? `${prefix}-${id}` : id;
}

/** The canonical `/locations/<slug>` path for a venue (see {@link locationSlug}). */
export function locationPath(location: Sluggable): string {
	return `/locations/${locationSlug(location)}`;
}
