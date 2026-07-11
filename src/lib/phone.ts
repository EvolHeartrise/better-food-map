// ---------------------------------------------------------------------------
// Phone numbers: the canonical stored form (normalizePhone) and the display
// renderer (formatPhone). The phone sibling of src/lib/address.ts — a location's
// `phone` arrives from world-editable OSM tags and agent input in every shape a
// human ever types (`+1-604-555-1234`, `+1 604 555 1234`, `+16045551234`,
// `(604) 555-1234`, `604-555-1234`), so we pin ONE canonical stored form and
// DERIVE the display on read, exactly as addresses store structured parts and
// derive the single line via formatAddress.
//
// Pure and runtime-agnostic (no node/bun/Worker APIs), so every layer shares one
// definition:
//   • the app        — VenueDetail renders formatPhone(phone).display + tel: href
//   • the JSON-LD    — venue-jsonld emits the E.164 as schema.org `telephone`
//   • the MCP server — create/update_locations store normalizePhone(...) canonical
//
// Coverage is North America first, so NANP (+1, ten national digits) is rendered
// precisely as `+1 (604) 555-1234`; any other country code is kept in E.164 and
// shown verbatim (we hold no per-country grouping rules). The country code is
// always part of the display whenever it is known. The `tel:` href always
// carries the fully-qualified E.164 so dialing works regardless of the display.
// ---------------------------------------------------------------------------

import { blankToNull } from './text';

/** A phone number rendered for display and for a `tel:` link. */
export interface FormattedPhone {
	/**
	 * Human-facing NUMBER, NO extension: NANP → `+1 (604) 555-1234`; else the
	 * E.164 (or cleaned raw). The country code is shown whenever it is known.
	 * The extension is returned separately so its label can be localized by the
	 * caller (this module stays framework/locale-free).
	 */
	display: string;
	/** Extension digits, or null — the caller renders the localized "ext." label. */
	extension: string | null;
	/**
	 * The dial target for a `tel:` link — the E.164 number (+ `;ext=` when present),
	 * WITHOUT the `tel:` scheme. Kept scheme-less so callers write `href="tel:{tel}"`
	 * (a static, lint-recognizable scheme) rather than a fully dynamic href.
	 */
	tel: string;
	/**
	 * E.164 international form, e.g. `+16045551234` — for schema.org `telephone`.
	 * Empty string only when the calling code could not be determined (a bare,
	 * non-NANP number with no `+`), which our data never contains.
	 */
	e164: string;
}

// An extension DIRECTLY attached to the end of a number, in every shape sources
// use: "x5", " ext. 78283", "#5", "extension 42". No leading separator class —
// it binds to the number it trails, and is matched on the PRIMARY segment AFTER
// the multi-value split (so a second number's extension never sticks to the first).
const ATTACHED_EXT_RE = /(?:ext\.?|extension|x|#)\s*[.:=]?\s*(\d{1,7})\s*$/i;
// A whole segment that IS an extension marker: the canonical ";ext=5" our own
// normalizePhone writes splits (on ';') into a bare "ext=5" segment — recognize it
// so the extension is restored rather than dropped as a bogus second number.
const SEGMENT_EXT_RE = /^(?:ext\.?|extension|x|#)\s*[.:=]?\s*(\d{1,7})$/i;

interface Parsed {
	/**
	 * Fully-qualified international number (`+16045551234`), or null when the
	 * calling code cannot be determined — a bare number with no `+` in a country
	 * we cannot resolve to a calling code.
	 */
	e164: string | null;
	/** The 10-digit NANP national number when this is a NANP (+1) number, else null. */
	nanpNational: string | null;
	/** The number body (separators intact) with any extension removed — fallback display. */
	body: string;
	/** All digits of the number body, extension excluded. */
	digits: string;
	/** Extension digits, or null. */
	extension: string | null;
}

/**
 * Parses a raw phone string into its canonical pieces, or null when it carries no
 * digits at all. `country` (ISO-2) lets a bare, `+`-less number be resolved: for
 * CA/US (or unknown) a 10-digit — or 11-digit leading-1 — number is read as NANP.
 */
function parse(raw: string | null | undefined, country?: string | null): Parsed | null {
	const cleaned = blankToNull(raw);
	if (!cleaned) return null;

	// OSM records multiple numbers separated by ';' (also seen: ',' '/'); the first
	// is the venue's primary line. Split BEFORE pulling the extension so a primary
	// number's extension and a following number are never confused for each other.
	const segments = cleaned
		.split(/[;,/]/)
		.map((s) => s.trim())
		.filter(Boolean);
	let body = segments[0] ?? '';
	let extension: string | null = null;

	const attached = ATTACHED_EXT_RE.exec(body);
	if (attached) {
		// An extension attached to the primary number ("…2905x5", "…6000 x78283").
		extension = attached[1];
		body = body.slice(0, attached.index).trim();
	} else if (segments[1]) {
		// The canonical ";ext=5" form re-parsed: a lone "ext=5" second segment is
		// the primary number's extension, not a second number. A segment that is a
		// full number (a genuine alternate line) is left behind with the number.
		const seg = SEGMENT_EXT_RE.exec(segments[1]);
		if (seg) extension = seg[1];
	}

	const hasPlus = body.startsWith('+');
	const digits = body.replace(/\D/g, '');
	if (!digits) return null;

	// `country?.toUpperCase()` is string | undefined (never null), so undefined
	// alone covers "no country given".
	const cc = country?.toUpperCase();
	const nanpEligible = cc === undefined || cc === 'CA' || cc === 'US';

	let nanpNational: string | null = null;
	if (hasPlus) {
		// A leading +1 with exactly ten more digits is NANP; any other + is a
		// country code we do not split (kept whole in E.164).
		if (digits.length === 11 && digits.startsWith('1')) nanpNational = digits.slice(1);
	} else if (nanpEligible) {
		if (digits.length === 10) nanpNational = digits;
		else if (digits.length === 11 && digits.startsWith('1')) nanpNational = digits.slice(1);
	}

	const e164 = nanpNational ? `+1${nanpNational}` : hasPlus ? `+${digits}` : null;
	return { e164, nanpNational, body, digits, extension };
}

/** Composes the display body (no extension) from a parsed number. */
function displayBody(p: Parsed): string {
	if (p.nanpNational) {
		const n = p.nanpNational;
		return `+1 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
	}
	// A recognized international number shows as its E.164; an unresolvable one
	// falls back to the cleaned raw so we never render blank.
	return p.e164 ?? p.body;
}

/**
 * Renders a stored/raw phone for display and dialing, or null when there is no
 * number at all. `display` is the human number (NANP → `+1 (604) 555-1234`, no
 * extension), `extension` the extension digits (caller adds the localized label),
 * `tel` the `tel:` dial target, `e164` the international number for schema.org.
 * Applied on READ so every venue shows a consistent number regardless of how the
 * source spelled it — the phone analogue of {@link formatAddress}.
 */
export function formatPhone(
	raw: string | null | undefined,
	country?: string | null
): FormattedPhone | null {
	const p = parse(raw, country);
	if (!p) return null;
	// Prefer the E.164 for the tel: target; with no known calling code, dial the
	// bare digits rather than fabricating a `+` (a wrong country code is worse).
	const telBase = p.e164 ?? p.digits;
	const tel = p.extension ? `${telBase};ext=${p.extension}` : telBase;
	return { display: displayBody(p), extension: p.extension, tel, e164: p.e164 ?? '' };
}

/**
 * The canonical STORED form of a phone: the E.164 number (`+16045551234`), plus a
 * `;ext=<n>` suffix when an extension is present. Applied on WRITE (create/update
 * locations) so stored numbers stay uniform — the phone analogue of the address
 * normalizers. Returns null when the value carries no digits. When the calling
 * code cannot be determined (a bare, non-NANP number), the cleaned number is kept
 * rather than fabricating one, so no real number is dropped.
 */
export function normalizePhone(
	raw: string | null | undefined,
	country?: string | null
): string | null {
	const p = parse(raw, country);
	if (!p) return null;
	const base = p.e164 ?? p.body;
	return p.extension ? `${base};ext=${p.extension}` : base;
}
