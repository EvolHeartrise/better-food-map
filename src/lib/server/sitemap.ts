// Pure XML builder behind `/sitemap.xml` (src/routes/sitemap.xml/+server.ts).
// Like db.ts, this module is RUNTIME-AGNOSTIC — no `bun:`/`node:` imports and no
// SvelteKit request context — so the same code runs in the Worker isolate and
// under `bun test`.

/**
 * The canonical public origin. Hard-coded rather than derived from the request:
 * hooks.server.ts 301-redirects every alias host here, and a sitemap must list
 * the URLs crawlers should index, not whichever host happened to serve the
 * fetch. Mirrors CANONICAL_ORIGIN in +page.svelte (the venue og:url).
 */
const ORIGIN = 'https://betterfoodmaps.com';

/** One sitemap row: a venue id plus its menu's last-verification date, or null. */
export interface SitemapEntry {
	id: string;
	last_verified: string | null;
}

/**
 * Escapes the five XML-special characters in an interpolated value. Ids are
 * UUIDs/short slugs today and `encodeURIComponent` already percent-encodes most
 * specials out of the path, but escaping everything we interpolate keeps the
 * document well-formed no matter what a future id (or lastmod string) contains
 * — notably `'`, which `encodeURIComponent` leaves alone.
 */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Builds the sitemap-protocol `<urlset>` document: the map root first, then one
 * `<url>` per open venue at its shareable `/locations/<id>` address — the same
 * canonical URL the venue head emits, served by the map page via the reroute in
 * src/hooks.ts. `<lastmod>` carries the menu's `last_verified` date when known
 * and is omitted otherwise: an invented date would be worse than none for a
 * crawler's revisit scheduling.
 */
export function buildSitemapXml(entries: SitemapEntry[]): string {
	const urls = [`<url><loc>${escapeXml(ORIGIN)}/</loc></url>`];
	for (const entry of entries) {
		const loc = escapeXml(`${ORIGIN}/locations/${encodeURIComponent(entry.id)}`);
		const lastmod = entry.last_verified
			? `<lastmod>${escapeXml(entry.last_verified)}</lastmod>`
			: '';
		urls.push(`<url><loc>${loc}</loc>${lastmod}</url>`);
	}
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
		urls.map((url) => `\t${url}`).join('\n') +
		'\n</urlset>\n'
	);
}
