// One page of the paginated sitemap, referenced by the index at /sitemap.xml
// (see that route for why the sitemap is a real API route at all). Serves the
// page's slice of the shared daily cache — no D1 read of its own.
import { error } from '@sveltejs/kit';
import { buildSitemapPageXml, SITEMAP_PAGE_SIZE, sitemapPageCount } from '$lib/server/sitemap';
import { cachedSitemapEntries } from '$lib/server/sitemap-cache';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	// The `int` matcher guarantees a plain 1–9999 integer, no leading zeros.
	const page = Number(params.page);
	const entries = await cachedSitemapEntries();
	if (page > sitemapPageCount(entries.length)) error(404, 'No such sitemap page');
	const slice = entries.slice((page - 1) * SITEMAP_PAGE_SIZE, page * SITEMAP_PAGE_SIZE);
	// The map root lives on page 1 alone: the index can't reference raw URLs,
	// and no URL may appear on two pages.
	return new Response(buildSitemapPageXml(slice, { includeRoot: page === 1 }), {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			// Same edge/crawler caching as the index: reusable for a day, bounding
			// how often the Worker runs at all.
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
