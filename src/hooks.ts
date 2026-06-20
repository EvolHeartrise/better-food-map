import type { Reroute } from '@sveltejs/kit';

// A selected location is shown inline on the map page via shallow routing, so
// the address bar reads `/locations/<id>` without a real navigation. There is no
// `/locations/[id]` route anymore, so a refresh or shared link to that URL would
// otherwise 404. Rerouting it to `/` serves the map page (which reads the id from
// the URL and opens the detail panel). `reroute` only changes which route is
// matched — the address bar still shows `/locations/<id>`.
export const reroute: Reroute = ({ url }) => {
	if (url.pathname.startsWith('/locations/')) {
		return '/';
	}
};
