// Pure url plumbing for baseline.ts: pull candidate watch urls out of a menu's
// banked provenance (menu_sources) and refresh_notes prose, and drop the hosts
// that can never fingerprint usefully.

/**
 * Hosts that are never a menu source worth watching (socials, map/review
 * links). Matched as the host or any subdomain — except google.com, which is
 * matched EXACTLY so docs/sites/drive.google.com stay watchable (small venues
 * genuinely host menus there) while google.com/maps and search links drop.
 */
const SKIP_HOSTS = [
	'facebook.com',
	'instagram.com',
	'twitter.com',
	'x.com',
	'tiktok.com',
	'youtube.com',
	'goo.gl',
	'maps.app.goo.gl',
	'maps.google.com',
	'yelp.com',
	'tripadvisor.com'
];
const SKIP_HOSTS_EXACT = ['google.com'];

/** Watch sets stay small on purpose — a menu with more pages than this needs curation. */
export const MAX_WATCH_URLS = 15;

/** Extract http(s) urls from free text (refresh_notes prose), trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
	const matches = text.match(/https?:\/\/[^\s"'<>()[\]]+/g) ?? [];
	return matches.map((u) => u.replace(/[.,;:!?]+$/, ''));
}

function isSkippedHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^www\./, '');
	if (SKIP_HOSTS_EXACT.includes(h)) return true;
	return SKIP_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Validate/normalize a url list: http(s) only, fragments stripped,
 * de-duplicated in first-seen order, capped at MAX_WATCH_URLS. Used verbatim
 * for explicit `--urls` overrides (no host skipping — curation trusts the
 * operator, but a duplicate/invalid url must never reach the INSERT batch).
 */
export function sanitizeUrls(raw: string[], skipHosts = false): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of raw) {
		let u: URL;
		try {
			u = new URL(candidate);
		} catch {
			continue;
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
		if (skipHosts && isSkippedHost(u.host)) continue;
		u.hash = '';
		const url = u.href;
		if (seen.has(url)) continue;
		seen.add(url);
		out.push(url);
		if (out.length === MAX_WATCH_URLS) break;
	}
	return out;
}

/**
 * Candidate watch urls for a menu: provenance urls + urls mined from
 * refresh_notes, invalid/social/map urls dropped, fragments stripped,
 * de-duplicated in first-seen order, capped at MAX_WATCH_URLS.
 */
export function deriveWatchUrls(sourceUrls: string[], refreshNotes: string | null): string[] {
	return sanitizeUrls([...sourceUrls, ...extractUrls(refreshNotes ?? '')], true);
}
