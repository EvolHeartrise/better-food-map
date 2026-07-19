// Pure content → fingerprint normalizers for the menu-source change gate.
//
// Raw byte-hashing a web page is useless for change detection: CSRF tokens,
// nonces, rotating asset fingerprints and cookie banners make nearly every
// fetch differ. Each source kind therefore gets a normalization pipeline that
// strips the churn BEFORE hashing, so an unchanged hash actually means "the
// menu-relevant content is unchanged":
//
//   feed      parse JSON, drop volatile keys (timestamps, tokens, request ids),
//             sort object keys, hash the canonical string.
//   pdf       hash the EXTRACTED TEXT (regenerated PDFs get fresh /CreationDate
//             and /ID metadata with identical content, so bytes always differ).
//   html      hash the visible text (tags, scripts, styles, attributes gone).
//   rendered  same as html, but over the post-JS DOM's innerText.
//
// Hashes carry their pipeline as a prefix ("feed:", "text:", "bytes:") so two
// different pipelines can never compare equal by accident — a pdftotext-less
// environment producing "bytes:…" against a "text:…" baseline reads as changed
// and fails open into the agent path.
//
// This module is dependency-free and side-effect-free; everything IO lives in
// fetcher.ts / check.ts / baseline.ts.

import { createHash } from 'node:crypto';

export function sha256(text: string | Uint8Array): string {
	return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// feed (JSON) normalization
// ---------------------------------------------------------------------------

// A key containing any of these fragments (case-insensitive) is dropped before
// hashing. Over-stripping is the cheap failure here: a real menu change never
// lives ONLY in a timestamp/token field, while under-stripping makes every
// fetch hash differently and the gate saves nothing.
const VOLATILE_KEY_FRAGMENTS = [
	'timestamp',
	'nonce',
	'token',
	'session',
	'csrf',
	'trace',
	'request_id',
	'requestid',
	'expires',
	'expiry',
	'signature',
	'generated',
	'fetched',
	'updated_at',
	'updatedat',
	'created_at',
	'createdat',
	'last_modified',
	'lastmodified',
	'cache',
	'etag',
	'server_time',
	'servertime'
];

// A string VALUE that is an ISO datetime WITH a time component is volatile
// metadata (generated-at stamps) regardless of key. Bare dates ("2026-07-18")
// are kept — a promo end date is content.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function isVolatileKey(key: string): boolean {
	const k = key.toLowerCase();
	return VOLATILE_KEY_FRAGMENTS.some((f) => k.includes(f));
}

/** Recursively drops volatile keys/values; arrays keep their order (feed order is content). */
export function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			if (isVolatileKey(key)) continue;
			const v = (value as Record<string, unknown>)[key];
			if (typeof v === 'string' && ISO_DATETIME.test(v)) continue;
			out[key] = stripVolatile(v);
		}
		return out;
	}
	if (typeof value === 'string' && ISO_DATETIME.test(value)) return null;
	return value;
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value as Record<string, unknown>).toSorted();
		const body = keys
			.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
			.join(',');
		return `{${body}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** JSON body → canonical volatile-stripped string, or null when not JSON. */
export function feedNormalize(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	return canonicalJson(stripVolatile(parsed));
}

// ---------------------------------------------------------------------------
// html → visible text
// ---------------------------------------------------------------------------

const BLOCK_END =
	/<\/(?:p|div|li|ul|ol|tr|td|th|table|section|article|header|footer|h[1-6]|dt|dd|blockquote|figcaption)>|<(?:br|hr)\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	eacute: 'é',
	egrave: 'è',
	agrave: 'à',
	ccedil: 'ç'
};

export function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Visible text of an HTML document, one trimmed line per block-level element,
 * empty lines dropped. Line structure is load-bearing: priceSignal() below
 * works line-by-line, so block boundaries must become newlines before tags go.
 */
export function visibleText(html: string): string {
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(BLOCK_END, '\n')
		.replace(/<[^>]*>/g, ' ');
	return decodeEntities(stripped)
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

export function htmlTitle(html: string): string {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// ---------------------------------------------------------------------------
// price signal — the menu-shaped subset of a page's text
// ---------------------------------------------------------------------------

// A currency-symbol amount, or a bare 12.95-style decimal (menus routinely
// print prices without a symbol). The bare form must not swallow dates or
// version strings, hence the lookarounds barring a third decimal segment.
const PRICE_TOKEN = /[$£€]\s?\d{1,4}(?:[.,]\d{2})?|(?<![\d.,])\d{1,4}[.,]\d{2}(?![.,]?\d)(?!\s*%)/;

/**
 * The sorted multiset of text lines carrying a price token. A restaurant
 * homepage's "hours this week" banner or review-count widget changes weekly;
 * its price list does not — so for html/rendered pages this is compared in
 * preference to the full-text hash. Sorting makes the signal order-insensitive
 * (menu sections get reshuffled cosmetically more often than repriced).
 *
 * Returns null when fewer than MIN_PRICE_LINES lines qualify: one or two
 * incidental decimals are too thin a signal to gate on, so comparison falls
 * back to the full content hash. A description-only edit on a price line's
 * page is invisible to this signal — that class of change rides the periodic
 * full-refresh floor instead (see check.ts --max-age-days).
 */
export const MIN_PRICE_LINES = 3;

export function priceSignal(text: string): string | null {
	const lines = text.split('\n').filter((line) => PRICE_TOKEN.test(line));
	if (lines.length < MIN_PRICE_LINES) return null;
	return lines.toSorted().join('\n');
}

// ---------------------------------------------------------------------------
// degenerate detection
// ---------------------------------------------------------------------------

// A bot-wall or error interstitial hashes perfectly stable forever — the one
// way this mechanism could silently mark a changing menu "unchanged". Any page
// whose visible text is this thin cannot be a real menu page, so its hash is
// never trusted. Bot-wall PHRASE detection lives in fetcher.ts (it reuses the
// bench recorder's looksLikeBotWall, which also needs the HTTP status).
export const MIN_TEXT_LEN = 200;

export function isDegenerate(text: string): boolean {
	return text.replace(/\s+/g, ' ').trim().length < MIN_TEXT_LEN;
}

// ---------------------------------------------------------------------------
// hash assembly
// ---------------------------------------------------------------------------

export type HashVariant = 'feed' | 'text' | 'bytes';

export function contentHash(variant: HashVariant, normalized: string | Uint8Array): string {
	return `${variant}:${sha256(normalized)}`;
}

export function signalHash(text: string): string | null {
	const signal = priceSignal(text);
	return signal === null ? null : `signal:${sha256(signal)}`;
}
