import type { Reroute } from '@sveltejs/kit';

// A selected location is shown inline on the map page (the root `/`) via shallow
// routing, so the address bar reads `/locations/<id>` without a real navigation.
// There is no `/locations/[id]` route, so a refresh or shared link to that URL would
// otherwise 404. Rerouting it to `/` serves the map page (which reads the id from the
// URL and opens the detail panel). `reroute` only changes which route is matched —
// the address bar still shows `/locations/<id>`, and `event.url` is unchanged.
//
// Legacy `/map/locations/<id>` links (from when the map lived under `/map`) are
// 301-redirected to `/locations/<id>` server-side (see hooks.server.ts) before they
// reach here, so this only needs to handle the canonical `/locations/*` shape.
export const reroute: Reroute = ({ url }) => {
	if (url.pathname.startsWith('/locations/')) return '/';
};
