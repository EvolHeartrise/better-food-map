// ---------------------------------------------------------------------------
// Structured postal address: the canonical shape, the single-line display
// formatter, and the normalizers that keep stored parts uniform.
//
// Pure and runtime-agnostic (no node/bun/Worker APIs), so every layer shares
// ONE definition of "what a normalized address looks like":
//   • the Worker/app  — src/lib/server/db.ts derives the display line from parts
//   • the MCP server  — scripts/db-mcp-server.ts canonicalizes agent-supplied parts
//   • the backfill    — scripts/backfill-address-parts.ts re-derives parts from OSM
//
// A location stores `street`, `city`, `region`, `country` (all required) and an
// optional `postcode`. `region` is a 2-letter province/state code and `country`
// an ISO-3166-1 alpha-2 code, so the data stays uniform regardless of how the
// source spelled them.
// ---------------------------------------------------------------------------

import { blankToNull, collapseWhitespace, stripDiacritics } from './text';

/** A structured postal address. `postcode` is the only optional part. */
export interface AddressParts {
	/** House number + street (+ unit), e.g. "1909 W 4th Ave" or "100-6485 120 St". */
	street: string;
	/** Municipality, e.g. "Vancouver". */
	city: string;
	/** 2-letter province/state code, e.g. "BC", "ON". */
	region: string;
	/** Postal/ZIP code in canonical form (e.g. "V6J 1M5"), or null if unknown. */
	postcode: string | null;
	/** ISO-3166-1 alpha-2 country code, e.g. "CA". */
	country: string;
}

/**
 * Composes a single-line address from possibly-missing parts: `street, city,
 * REGION postcode` (region and postcode joined by a space; any blank part
 * dropped). Returns null when no part is present. The null-tolerant sibling of
 * {@link formatAddress}: the ingestion/staging composers (OSM, Overture, the
 * audit tools) work from raw, partial source fields, so they share this ONE
 * renderer rather than each hand-rolling a `.filter(Boolean).join(', ')` — which
 * is what kept their region/postcode separator drifting apart.
 */
export function composeAddressLine(parts: {
	street?: string | null;
	city?: string | null;
	region?: string | null;
	postcode?: string | null;
}): string | null {
	const region = blankToNull(parts.region)?.trim();
	const postcode = blankToNull(parts.postcode)?.trim();
	const regionAndPostcode = region && postcode ? `${region} ${postcode}` : (region ?? postcode);
	const line = [parts.street, parts.city, regionAndPostcode]
		.map((p) => p?.trim())
		.filter((p): p is string => Boolean(p))
		.join(', ');
	return line || null;
}

/**
 * The canonical single-line display address: `street, city, REGION postcode`
 * (region and postcode joined by a space; postcode omitted when null). Country
 * is intentionally not rendered — it is stored, not shown, on this map. Example:
 * `1909 W 4th Ave, Vancouver, BC V6J 1M5`. Empty string only when every part is
 * blank (never for a normally-populated, required-parts row).
 */
export function formatAddress(parts: {
	street: string;
	city: string;
	region: string;
	postcode: string | null;
}): string {
	return composeAddressLine(parts) ?? '';
}

/** Canadian province/territory codes. */
const CA_REGION_CODES = new Set([
	'AB',
	'BC',
	'MB',
	'NB',
	'NL',
	'NS',
	'NT',
	'NU',
	'ON',
	'PE',
	'QC',
	'SK',
	'YT'
]);

/** Full Canadian province/territory names → code (lowercased keys; é-folded). */
const CA_REGION_NAMES: Record<string, string> = {
	alberta: 'AB',
	'british columbia': 'BC',
	manitoba: 'MB',
	'new brunswick': 'NB',
	'newfoundland and labrador': 'NL',
	newfoundland: 'NL',
	'nova scotia': 'NS',
	'northwest territories': 'NT',
	nunavut: 'NU',
	ontario: 'ON',
	'prince edward island': 'PE',
	pei: 'PE',
	quebec: 'QC',
	saskatchewan: 'SK',
	yukon: 'YT'
};

/** US state/territory codes. */
const US_REGION_CODES = new Set([
	'AL',
	'AK',
	'AZ',
	'AR',
	'CA',
	'CO',
	'CT',
	'DE',
	'FL',
	'GA',
	'HI',
	'ID',
	'IL',
	'IN',
	'IA',
	'KS',
	'KY',
	'LA',
	'ME',
	'MD',
	'MA',
	'MI',
	'MN',
	'MS',
	'MO',
	'MT',
	'NE',
	'NV',
	'NH',
	'NJ',
	'NM',
	'NY',
	'NC',
	'ND',
	'OH',
	'OK',
	'OR',
	'PA',
	'RI',
	'SC',
	'SD',
	'TN',
	'TX',
	'UT',
	'VT',
	'VA',
	'WA',
	'WV',
	'WI',
	'WY',
	'DC'
]);

/** Full US state names → code (lowercased keys). */
const US_REGION_NAMES: Record<string, string> = {
	alabama: 'AL',
	alaska: 'AK',
	arizona: 'AZ',
	arkansas: 'AR',
	california: 'CA',
	colorado: 'CO',
	connecticut: 'CT',
	delaware: 'DE',
	florida: 'FL',
	georgia: 'GA',
	hawaii: 'HI',
	idaho: 'ID',
	illinois: 'IL',
	indiana: 'IN',
	iowa: 'IA',
	kansas: 'KS',
	kentucky: 'KY',
	louisiana: 'LA',
	maine: 'ME',
	maryland: 'MD',
	massachusetts: 'MA',
	michigan: 'MI',
	minnesota: 'MN',
	mississippi: 'MS',
	missouri: 'MO',
	montana: 'MT',
	nebraska: 'NE',
	nevada: 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	ohio: 'OH',
	oklahoma: 'OK',
	oregon: 'OR',
	pennsylvania: 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	tennessee: 'TN',
	texas: 'TX',
	utah: 'UT',
	vermont: 'VT',
	virginia: 'VA',
	washington: 'WA',
	'west virginia': 'WV',
	wisconsin: 'WI',
	wyoming: 'WY',
	'district of columbia': 'DC'
};

/** Lowercases, trims, collapses whitespace, and folds the lone accented vowels we expect. */
function foldName(value: string): string {
	return collapseWhitespace(stripDiacritics(value)).toLowerCase();
}

/**
 * Folds the spelling variants sources use for region names: "&" for "and"
 * ("Newfoundland & Labrador"), dotted abbreviations ("P.E.I."), and non-Latin
 * co-names in bilingual OSM labels ("ᓄᓇᕗᑦ Nunavut"). Applied only on the
 * full-name path of {@link normalizeRegion} — codes never carry any of these.
 */
function foldRegionName(value: string): string {
	return foldName(
		stripDiacritics(value)
			.replace(/&/g, ' and ')
			.replace(/\./g, '')
			.replace(/[^\x20-\x7e]+/g, ' ')
	);
}

/**
 * Normalizes a province/state to its 2-letter code. Accepts an existing code
 * (any case) or a full name (CA or US). `countryCode` (ISO-2) disambiguates and
 * scopes the lookup when known. Returns null when it cannot be resolved — the
 * caller decides whether that is a hard failure.
 */
export function normalizeRegion(
	value: string | null | undefined,
	countryCode?: string | null
): string | null {
	if (!value) return null;
	const raw = value.trim();
	if (!raw) return null;

	const upper = raw.toUpperCase();
	const cc = countryCode?.toUpperCase();

	// Already a code?
	if (/^[A-Z]{2}$/.test(upper)) {
		if (cc === 'CA') return CA_REGION_CODES.has(upper) ? upper : null;
		if (cc === 'US') return US_REGION_CODES.has(upper) ? upper : null;
		if (CA_REGION_CODES.has(upper) || US_REGION_CODES.has(upper)) return upper;
		return null;
	}

	// Full name → code. A bilingual OSM label ("New Brunswick / Nouveau-Brunswick")
	// is tried whole first, then one slash-separated segment at a time.
	const keys = [raw, ...(raw.includes('/') ? raw.split('/') : [])].map(foldRegionName);
	for (const key of keys) {
		if (!key) continue;
		// A dotted/spaced code ("B.C.", "ON.") folds down to two letters — validate
		// it as a code rather than looking it up as a name.
		if (/^[a-z]{2}$/.test(key)) {
			const asCode = normalizeRegion(key.toUpperCase(), cc);
			if (asCode) return asCode;
			continue;
		}
		const code =
			cc === 'CA'
				? CA_REGION_NAMES[key]
				: cc === 'US'
					? US_REGION_NAMES[key]
					: (CA_REGION_NAMES[key] ?? US_REGION_NAMES[key]);
		if (code) return code;
	}
	return null;
}

/**
 * The country a province/state belongs to, from a raw region value (code or
 * full name, any of the spellings {@link normalizeRegion} accepts). The CA and
 * US code sets are disjoint, so a resolvable region uniquely determines its
 * country. Returns null when the region cannot be resolved — the caller decides
 * whether "unknown" is a match or a miss.
 */
export function regionCountry(value: string | null | undefined): 'CA' | 'US' | null {
	const code = normalizeRegion(value);
	if (!code) return null;
	if (CA_REGION_CODES.has(code)) return 'CA';
	if (US_REGION_CODES.has(code)) return 'US';
	return null;
}

const CA_POSTCODE = /^([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)$/;
const US_ZIP = /^(\d{5})(?:-(\d{4}))?$/;

/**
 * Normalizes a postal/ZIP code to canonical form, or returns null when the value
 * is absent, partial, or not a recognizable full code. Canada → `A1A 1A1`
 * (single space, uppercase); US → `12345` or `12345-6789`. Partial Canadian
 * codes (e.g. a bare FSA like "T5R") are rejected — a half code is worse than
 * none. `countryCode` scopes the check when known.
 */
export function normalizePostcode(
	value: string | null | undefined,
	countryCode?: string | null
): string | null {
	if (!value) return null;
	const raw = value.trim();
	if (!raw) return null;
	const cc = countryCode?.toUpperCase();

	if (cc === undefined || cc === 'CA') {
		const m = raw.toUpperCase().match(CA_POSTCODE);
		if (m) return `${m[1]} ${m[2]}`;
		if (cc === 'CA') return null;
	}
	if (cc === undefined || cc === 'US') {
		const m = raw.match(US_ZIP);
		if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
		if (cc === 'US') return null;
	}
	return null;
}

/** Common country spellings → ISO-2. */
const COUNTRY_NAMES: Record<string, string> = {
	canada: 'CA',
	ca: 'CA',
	'united states': 'US',
	'united states of america': 'US',
	usa: 'US',
	us: 'US',
	'united kingdom': 'GB',
	uk: 'GB',
	'great britain': 'GB',
	gb: 'GB',
	australia: 'AU',
	au: 'AU',
	'new zealand': 'NZ',
	nz: 'NZ',
	ireland: 'IE',
	ie: 'IE'
};

/**
 * Normalizes a country to an ISO-3166-1 alpha-2 code. Accepts an existing code
 * (e.g. Nominatim's `country_code` "ca") or a name ("Canada"). Returns null when
 * unrecognized.
 */
export function normalizeCountry(value: string | null | undefined): string | null {
	if (!value) return null;
	const raw = value.trim();
	if (!raw) return null;
	if (/^[A-Za-z]{2}$/.test(raw)) {
		const code = raw.toUpperCase();
		// Trust any 2-letter code, but normalize the spellings we know.
		return COUNTRY_NAMES[raw.toLowerCase()] ?? code;
	}
	return COUNTRY_NAMES[foldName(raw)] ?? null;
}

/**
 * Composes the single-line `street` part from its pieces. Unit is rendered in the
 * Canadian hyphen style (`100-6485 120 St`) when both unit and house number are
 * present; otherwise it is prefixed plainly. Returns null when there is no street
 * name at all (a bare number is not a usable street).
 */
export function composeStreet(
	houseNumber: string | null | undefined,
	street: string | null | undefined,
	unit?: string | null
): string | null {
	const st = blankToNull(street);
	if (!st) return null;
	const num = blankToNull(houseNumber);
	const u = blankToNull(unit);
	const numberPart = num && u ? `${u}-${num}` : (num ?? '');
	const head = numberPart ? `${numberPart} ${st}` : st;
	return u && !num ? `${head}, Unit ${u}` : head;
}
