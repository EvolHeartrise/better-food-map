// Pure XML builders behind the sitemap routes: the index at `/sitemap.xml`
// (src/routes/sitemap.xml/+server.ts) and its pages at `/sitemaps/<n>.xml`
// (src/routes/sitemaps/[page=int].xml/+server.ts). Like db.ts, this module is
// RUNTIME-AGNOSTIC — no `bun:`/`node:` imports and no SvelteKit request
// context — so the same code runs in the Worker isolate and under `bun test`.
// (locationPath and its slugify transitively, and CANONICAL_ORIGIN, are all
// pure/client-safe too, imported relatively — never via `$lib` — so `bun test`
// resolves them.)
import { locationPath } from '../location-path';
import { CANONICAL_ORIGIN } from '../canonical';

/**
 * The canonical public origin (shared with the venue head and browse pages).
 * A sitemap must list the URLs crawlers should index, not whichever alias host
 * happened to serve the fetch — hooks.server.ts 301s every alias onto this one.
 */
const ORIGIN = CANONICAL_ORIGIN;

/**
 * Venue entries per sitemap page. The sitemap protocol caps a file at 50,000
 * URLs; 40,000 leaves headroom so page 1's extra root URL — or a future
 * hand-curated URL or two — can never nudge a page over the limit.
 */
export const SITEMAP_PAGE_SIZE = 40_000;

/**
 * One sitemap row: a venue's id plus the `name`/`city` that build its canonical
 * descriptive slug (see `locationSlug`), and its menu's last-verification date
 * (or null). name/city ride along so a page can be emitted at its slugged URL
 * without a second read.
 */
export interface SitemapEntry {
	id: string;
	name: string;
	city: string;
	last_verified: string | null;
}

/**
 * How many sitemap pages `totalEntries` venues need. Never zero: an empty
 * dataset still yields one (root-only) page, so `/sitemaps/1.xml` — a URL the
 * index always advertises — always exists. `pageSize` is parameterised so
 * tests can exercise the math without 40k-entry arrays.
 */
export function sitemapPageCount(totalEntries: number, pageSize = SITEMAP_PAGE_SIZE): number {
	return Math.max(1, Math.ceil(totalEntries / pageSize));
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
 * Builds one page of the sitemap as a `<urlset>` document: one `<url>` per
 * open venue at its shareable `/locations/<id>` address — the same canonical
 * URL the venue head emits, served by the map page via the reroute in
 * src/hooks.ts. `includeRoot` prepends the map root, which page 1 alone
 * carries: an index may only reference sitemap files, never raw URLs, so the
 * root has to live in a urlset — and exactly one, or crawlers see duplicate
 * listings. `<lastmod>` carries the menu's `last_verified` date when known and
 * is omitted otherwise: an invented date would be worse than none for a
 * crawler's revisit scheduling.
 */
export function buildSitemapPageXml(
	entries: SitemapEntry[],
	{ includeRoot }: { includeRoot: boolean }
): string {
	const urls = includeRoot ? [`<url><loc>${escapeXml(ORIGIN)}/</loc></url>`] : [];
	for (const entry of entries) {
		// The canonical descriptive URL — the SAME address the venue head's
		// <link rel="canonical"> emits and the server 301s bare/wrong-slug URLs
		// onto (all three share locationPath). Still XML-escaped: locationPath
		// percent-encodes the id but not the human slug prefix, so escaping keeps
		// the document well-formed no matter what a name folds down to.
		const loc = escapeXml(`${ORIGIN}${locationPath(entry)}`);
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

/**
 * Builds the `<sitemapindex>` document served at `/sitemap.xml`: one
 * `<sitemap>` per {@link SITEMAP_PAGE_SIZE}-sized page of `entries`, pointing
 * at `/sitemaps/<n>.xml`. Each page's `<lastmod>` is the MAX `last_verified`
 * across its entries — the date anything in that file last changed — so
 * crawlers can skip pages whose venues are all unchanged; a page with no
 * dated entries omits it. `pageSize` is parameterised for the same reason as
 * in {@link sitemapPageCount}.
 */
export function buildSitemapIndexXml(
	entries: SitemapEntry[],
	pageSize = SITEMAP_PAGE_SIZE
): string {
	const sitemaps: string[] = [];
	for (let page = 1; page <= sitemapPageCount(entries.length, pageSize); page++) {
		let latest: string | null = null;
		for (const entry of entries.slice((page - 1) * pageSize, page * pageSize)) {
			// ISO dates compare correctly as strings, so `>` finds the max.
			if (entry.last_verified && (!latest || entry.last_verified > latest)) {
				latest = entry.last_verified;
			}
		}
		const loc = escapeXml(`${ORIGIN}/sitemaps/${page}.xml`);
		const lastmod = latest ? `<lastmod>${escapeXml(latest)}</lastmod>` : '';
		sitemaps.push(`<sitemap><loc>${loc}</loc>${lastmod}</sitemap>`);
	}
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
		sitemaps.map((sitemap) => `\t${sitemap}`).join('\n') +
		'\n</sitemapindex>\n'
	);
}
