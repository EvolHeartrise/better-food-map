// Server 404 gate for the synthetic `/locations/<id>` URLs. A deliberate
// exception to the remote-functions-over-`load` convention (CLAUDE.md), in the
// same class as the sitemap routes (see src/routes/sitemap.xml/+server.ts): an
// HTTP status can only be set server-side, before anything renders, and no
// remote function can do that. Without this load, a hard load of an UNKNOWN or
// CLOSED venue id answers 200 with the generic map — the `reroute` hook
// (src/hooks.ts) serves this root page for every `/locations/*` path, and the
// component just renders with no venue found. That soft-404 hands crawlers an
// infinite indexable URL space and keeps closed venues' pages in the index
// forever; a real 404 (rendering +error.svelte) is the honest signal that
// drops them out.
//
// Cost: this load runs on every hard load of the root route, so the plain-`/`
// path must — and does — return immediately with zero work. Selecting a venue
// on the client is shallow routing (`pushState`/`replaceState` in
// +page.svelte), which never re-runs a load, so the existence probe costs one
// extra D1 read only on hard loads of `/locations/<id>` URLs. For a VALID id
// nothing changes: the component's own SSR `getLocationData` fetch still
// populates the head, exactly as before.
import { error } from '@sveltejs/kit';
import { idFromPath } from '$lib/location-path';
import { locationExists } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, platform }) => {
	// `reroute` only changes which route is matched — `event.url` still carries
	// the `/locations/<id>` pathname, so the id is recovered from it here with
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
		error(404, 'Location not found');
	}
	if (id === null) return {};

	// Defensive: the D1 binding is present in production and emulated by the
	// Cloudflare adapter under `vite dev`, but should it ever be missing, serving
	// the map (the component degrades to the default head) beats 500ing every
	// venue deep link.
	const db = platform?.env?.DB;
	if (!db) return {};

	// One single-column existence probe (see locationExists). Closed venues count
	// as absent on purpose: they're hidden from the map (migration 0015), so a
	// 404 is the honest crawler signal for their pages.
	if (!(await locationExists(db, id))) error(404, 'Location not found');
	return {};
};
