import type { Handle } from '@sveltejs/kit';

// betterfoodmaps.com is the canonical domain. The legacy bare domain
// betterfoodmap.com is also routed to this Worker (see wrangler.jsonc) purely so
// it can be 301-redirected here, preserving the path and query string. The
// redirect runs before `resolve`, so betterfoodmap.com never serves app content.
const CANONICAL_HOST = 'betterfoodmaps.com';
const REDIRECT_HOSTS = new Set(['betterfoodmap.com', 'www.betterfoodmap.com']);

export const handle: Handle = async ({ event, resolve }) => {
	const { hostname, pathname, search } = event.url;
	if (REDIRECT_HOSTS.has(hostname)) {
		return new Response(null, {
			status: 301,
			headers: { location: `https://${CANONICAL_HOST}${pathname}${search}` }
		});
	}
	return resolve(event);
};
