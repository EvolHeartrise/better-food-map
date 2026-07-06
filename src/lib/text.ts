// ---------------------------------------------------------------------------
// Tiny, pure, client-safe string helpers shared across the app and the OSM
// data-pipeline scripts. No node/bun/Worker APIs, so every layer can import the
// SAME normalization primitives (diacritic folding, whitespace collapsing)
// instead of re-implementing them — mirrors `$lib/category.ts` / `$lib/tags.ts`.
// ---------------------------------------------------------------------------

/** Decomposes accented characters and strips combining marks (Québec → Quebec). */
export function stripDiacritics(value: string): string {
	return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Collapses runs of whitespace to a single space and trims both ends. */
export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/** Collapses whitespace and maps an empty/whitespace-only result to null. */
export function blankToNull(value: string | null | undefined): string | null {
	if (!value) return null;
	const collapsed = collapseWhitespace(value);
	return collapsed.length ? collapsed : null;
}

// Named HTML entities that show up in scraped menu text. Deliberately a curated
// map (not a full HTML5 entity table): decoding must never mangle a legitimate
// "&word;" that only coincidentally looks like an obscure entity.
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	deg: '°',
	frac12: '½',
	frac14: '¼',
	frac34: '¾',
	middot: '·',
	bull: '•',
	reg: '®',
	copy: '©',
	trade: '™',
	eacute: 'é',
	egrave: 'è',
	agrave: 'à',
	ccedil: 'ç',
	ntilde: 'ñ',
	auml: 'ä',
	ouml: 'ö',
	uuml: 'ü',
	// HTML5-defined UPPERCASE legacy aliases (the spec's named-references list
	// defines exactly these — mixed-case forms like "&Amp;" are NOT valid HTML5,
	// so no general case folding here).
	AMP: '&',
	LT: '<',
	GT: '>',
	QUOT: '"',
	COPY: '©',
	REG: '®',
	TRADE: '™'
};

const ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]{1,8}));/g;

/**
 * Decodes HTML character references (`&amp;` → `&`, `&#233;`/`&#xE9;` → `é`) that
 * leak into text scraped from web sources. Single-pass, standard semantics — a
 * double-encoded `&amp;amp;` decodes one level to `&amp;`. Unknown named
 * references (and anything not entity-shaped) pass through untouched.
 */
export function decodeHtmlEntities(value: string): string {
	if (!value.includes('&')) return value;
	const fromCode = (code: number, match: string) =>
		code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
			? String.fromCodePoint(code)
			: match;
	return value.replace(ENTITY_PATTERN, (match, dec, hex, named) => {
		if (dec !== undefined) return fromCode(Number.parseInt(dec, 10), match);
		if (hex !== undefined) return fromCode(Number.parseInt(hex, 16), match);
		return NAMED_ENTITIES[named] ?? match;
	});
}
