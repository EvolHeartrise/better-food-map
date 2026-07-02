// Guards for untrusted external URLs before they become hrefs. Website and
// source URLs enter the database from world-editable feeds (OSM `website`
// tags, agent-supplied source citations), so the placecard must not hand an
// arbitrary scheme (`javascript:`, `data:`, …) to an anchor. Kept in a plain
// `$lib` module — no server-only imports — so the render side and the
// ingestion scripts share the exact same validation.

/**
 * Returns the URL unchanged when it parses with an `http:`/`https:` scheme,
 * otherwise `null`. This is the render-side allowlist: an anchor's `href` is
 * gated on it, and anything else (a `javascript:` URL, a scheme-less
 * "example.com", junk) is shown as plain text instead of linked. Being the
 * last layer, it also protects rows already in the database.
 */
export function safeHttpUrl(value: string): string | null {
	try {
		const protocol = new URL(value).protocol;
		return protocol === 'http:' || protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}

/**
 * True when the value carries an explicit URL scheme other than `http(s)` —
 * the ingestion-side rejection test. Unlike {@link safeHttpUrl} it lets
 * scheme-less strings through (an OSM `website=example.com` is sloppy but
 * harmless: the render guard shows it as text), so it only blocks values that
 * would otherwise smuggle an executable scheme into the database.
 */
export function hasNonHttpScheme(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol !== 'http:' && protocol !== 'https:';
	} catch {
		return false;
	}
}
