import type { Reroute } from '@sveltejs/kit';

// A selected location is shown inline on the map page via shallow routing, so the
// address bar reads `/map/locations/<id>` without a real navigation. There is no
// `/map/locations/[id]` route, so a refresh or shared link to that URL would
// otherwise 404. Rerouting it to `/map` serves the map page (which reads the id from
// the URL and opens the detail panel). `reroute` only changes which route is matched
// — the address bar still shows `/map/locations/<id>`, and `event.url` is unchanged,
// so the auth gate in hooks.server.ts still sees (and protects) the real path.
//
// Legacy `/locations/<id>` links (from before the map moved under `/map`) are
// rerouted to the same page so old shared links keep working; the map page reads the
// id from the path suffix either way.
export const reroute: Reroute = ({ url }) => {
	if (url.pathname.startsWith('/map/locations/')) return '/map';
	if (url.pathname.startsWith('/locations/')) return '/map';
};
