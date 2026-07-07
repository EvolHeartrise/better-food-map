// Server gate for the synthetic `/locations/<…>` URLs: 404 unknown/closed
// venues, and 301 non-canonical (bare-id or wrong-slug) URLs to the canonical
// descriptive `/locations/<name>-<city>-<uuid>` form. A deliberate exception to
// the remote-functions-over-`load` convention (CLAUDE.md), in the same class as
// the sitemap routes (see src/routes/sitemap.xml/+server.ts): an HTTP status —
// a 404 or a 301 redirect — can only be set server-side, before anything
// renders, and no remote function can do that.
//
// Without this load, a hard load of an UNKNOWN or CLOSED venue id answers 200
// with the generic map — the `reroute` hook (src/hooks.ts) serves this root page
// for every `/locations/*` path, and the component just renders with no venue
// found. That soft-404 hands crawlers an infinite indexable URL space and keeps
// closed venues' pages in the index forever; a real 404 (rendering
// +error.svelte) is the honest signal that drops them out. And a bare-id URL
// (`/locations/<uuid>`) or a stale-slug one served 200 would split a venue's
// link equity across many indexable addresses; the 301 folds them onto the one
// canonical URL the sitemap and the head's <link rel="canonical"> advertise.
//
// Cost: this load runs on every hard load of the root route, so the plain-`/`
// path must — and does — return immediately with zero work. Selecting a venue
// on the client is shallow routing (`pushState`/`replaceState` in +page.svelte,
// which already targets the canonical slug), which never re-runs a load, so the
// probe/redirect cost is paid only on hard loads of `/locations/<…>` URLs. For a
// VALID, already-canonical id nothing changes downstream: the component's own
// SSR `getLocationData` fetch still populates the head, exactly as before.
import { error, redirect } from '@sveltejs/kit';
import { idFromPath, locationPath } from '$lib/location-path';
import { getLocationSlugFields } from '$lib/server/db';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, platform }) => {
	// `reroute` only changes which route is matched — `event.url` still carries
	// the `/locations/<…>` pathname, so the id is recovered from it here with
	// the same helper the component uses (they must never disagree).
	let id: string | null;
	try {
		id = idFromPath(url.pathname);
	} catch {
		// Malformed percent-encoding (e.g. `/locations/%zz`) can't name a venue.
		// SvelteKit's runtime already rejects undecodable paths with a 400
		// ("Malformed URI") before routing, so this catch is belt-and-braces: if
		// an encoding quirk ever does reach us, answer 404 rather than letting
		// decodeURIComponent's URIError escalate to a 500.
		error(404, m.server_error_location_not_found());
	}
	if (id === null) return {};

	// Defensive: the D1 binding is present in production and emulated by the
	// Cloudflare adapter under `vite dev`, but should it ever be missing, serving
	// the map (the component degrades to the default head) beats 500ing every
	// venue deep link.
	const db = platform?.env?.DB;
	if (!db) return {};

	// One three-column read (see getLocationSlugFields). Closed venues count as
	// absent on purpose: they're hidden from the map (migration 0015), so a 404 is
	// the honest crawler signal for their pages.
	const venue = await getLocationSlugFields(db, id);
	if (!venue) error(404, m.server_error_location_not_found());

	// Fold every non-canonical spelling of this venue's URL onto the one canonical
	// slug. `locationPath` is deterministic and yields only URL-safe characters,
	// so a request that ALREADY sits on the canonical path recomputes the same
	// pathname and does not redirect — no loop. The query string is preserved so
	// campaign/tracking params survive the redirect.
	const canonical = locationPath(venue);
	if (url.pathname !== canonical) redirect(301, `${canonical}${url.search}`);

	return {};
};
