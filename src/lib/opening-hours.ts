// ---------------------------------------------------------------------------
// Opening hours: the canonical stored forms and the parser between them. The
// hours sibling of src/lib/phone.ts — a location's hours arrive as an OSM
// `opening_hours` string (from the staging store verbatim, or typed by an agent
// off the venue's own site), and we store BOTH that raw string (provenance /
// interchange / drift-audit comparand) and a derived machine-readable weekly
// structure (`opening_hours_json`, integer minutes) that SQL can json_each and
// the client can render without parsing. Only the write path derives the JSON,
// always from the raw string, so the two columns cannot drift.
//
// The parser covers the subset of the OSM grammar that real food-POI values
// actually use — measured on the Canada staging store, day lists/ranges +
// HH:MM-HH:MM spans + off/closed + 24/7 parse 94% of values, and tolerating
// public-holiday (PH/SH) rules lifts that to ~97%. Anything beyond (month
// qualifiers, sunrise/sunset, open-ended "17:00+", inline comments) returns
// null: the raw string is still stored and displayed verbatim, it just isn't
// machine-readable.
//
// Pure and runtime-agnostic (no node/bun/Worker APIs), so every layer shares
// one definition:
//   • the app        — VenueDetail renders groupWeeklyHours(...) rows
//   • the MCP server — create/update_locations + import_chain store
//                      normalizeOpeningHours(...) raw + weeklyHoursJson(...) derived
//   • the scripts    — the backfill and future hours-drift audit reuse both
// ---------------------------------------------------------------------------

import { blankToNull } from './text';

/**
 * One open interval as [openMinute, closeMinute) — minutes since local
 * midnight. `closeMinute` may exceed 1440 for a span that runs into the next
 * day (e.g. "11:00-02:00" → [660, 1560]); a close equal to the open means open
 * 24h from that time (OSM semantics), stored as +1440.
 */
export type HoursSpan = [number, number];

/**
 * A week of hours: exactly 7 entries, Monday-first (OSM/ISO-8601 day order,
 * Mo=0 … Su=6). An empty entry means closed that day. This whole value,
 * JSON-stringified, is what `locations.opening_hours_json` stores.
 */
export type WeeklyHours = HoursSpan[][];

/** Upper bound we accept for a raw hours string (longest staging value is ~150 chars). */
export const OPENING_HOURS_MAX_LEN = 500;

const DAY_INDEX: Record<string, number> = {
	mo: 0,
	tu: 1,
	we: 2,
	th: 3,
	fr: 4,
	sa: 5,
	su: 6
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Normalizes a raw hours string to the stored form: unicode dashes → "-",
 * NBSP → space, collapsed whitespace, trimmed, no trailing ";". Returns null
 * for blank input, or a string over {@link OPENING_HOURS_MAX_LEN} / carrying
 * control characters (world-editable input; garbage is dropped, not stored).
 */
export function normalizeOpeningHours(raw: string | null | undefined): string | null {
	const cleaned = blankToNull(
		(raw ?? '')
			.replace(/[‐-―−]/g, '-') // hyphen/en/em/horizontal-bar dashes, minus sign
			.replace(/\u00a0/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[;\s]+$/, '')
	);
	if (cleaned === null) return null;
	// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
	if (cleaned.length > OPENING_HOURS_MAX_LEN || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
	return cleaned;
}

/** "8:30" / "08.30" → minutes since midnight; null when not a plausible time. */
function parseTime(token: string): number | null {
	const m = token.match(/^(\d{1,2})[:.](\d{2})$/);
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	// OSM allows hours past 24 for explicit next-day closes (rare but legal, ≤48).
	if (h > 48 || min > 59) return null;
	return h * 60 + min;
}

/**
 * Parses a comma-separated list of "HH:MM-HH:MM" spans. Returns null when any
 * piece is not a plain span (open-ended "17:00+", event syntax, …).
 */
function parseSpans(text: string): HoursSpan[] | null {
	const out: HoursSpan[] = [];
	for (const piece of text.split(',')) {
		const m = piece.trim().match(/^(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})$/);
		if (!m) return null;
		const open = parseTime(m[1]);
		let close = parseTime(m[2]);
		if (open === null || close === null || open >= 1440) return null;
		// A close at/before the open runs into the next day ("11:00-02:00");
		// "11:00-11:00" is OSM for open 24h from 11:00.
		if (close <= open) close += 1440;
		out.push([open, close]);
	}
	return out.length ? out : null;
}

/** True when a lowercased selector token is a public/school-holiday token. */
function isHolidayToken(token: string): boolean {
	return token === 'ph' || token === 'sh';
}

/**
 * Parses a day selector ("Mo-Fr", "Sa,Su", "Mo-We,Fr", "Su,PH") into
 * Monday-first day indices. Ranges wrap ("Su-Th" → Su,Mo,Tu,We,Th); holiday
 * tokens (PH/SH) are tolerated and skipped — they aren't representable in a
 * weekly table. Returns null on any other token; an empty array means the
 * selector was ONLY holiday tokens (the caller skips the rule).
 */
function parseDays(text: string): number[] | null {
	const out: number[] = [];
	for (const piece of text.split(',')) {
		const token = piece.replace(/\s+/g, '').toLowerCase();
		if (isHolidayToken(token)) continue;
		const m = token.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
		if (!m) return null;
		const from = DAY_INDEX[m[1]];
		if (from === undefined) return null;
		if (m[2] === undefined) {
			out.push(from);
			continue;
		}
		const to = DAY_INDEX[m[2]];
		if (to === undefined) return null;
		for (let d = from; ; d = (d + 1) % 7) {
			out.push(d);
			if (d === to) break;
		}
	}
	return out;
}

// One rule: an optional day selector, then spans or off/closed. The selector is
// only letters/commas/hyphens so it can never swallow a time token.
const RULE =
	/^([A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?(?:\s*,\s*[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?)*)?\s*:?\s*(off|closed|[\d:.,\s-]+)$/i;

// A whole ";"-segment that only concerns holidays ("PH off", "PH unknown",
// "PH 11:00-22:00"): tolerated and skipped — it says nothing about weekdays.
const HOLIDAY_ONLY_SEGMENT = /^(?:PH|SH)(?:\s*,\s*(?:PH|SH))*\s+\S.*$/i;

// A day selector at a comma boundary means "new additive rule": a day (or
// PH/SH) token followed by a separator, so a stray two-letter word inside a
// span list can't false-positive.
const RULE_BOUNDARY = /,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b\s*[,\s:-])/gi;

/**
 * Splits one ";"-segment into its ","-separated ADDITIVE rules without
 * breaking the commas inside a rule's own day list or span list. The boundary
 * over-splits a day LIST ("Fr,Sa 10:30-24:00" → "Fr" + "Sa 10:30-24:00"), so a
 * fragment with no body (no digits, no off/closed) is re-attached to the next
 * fragment's day list.
 */
function splitAdditiveRules(segment: string): string[] {
	const out: string[] = [];
	for (const part of segment.split(RULE_BOUNDARY)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const prev = out[out.length - 1];
		if (prev !== undefined && !/(\d|off|closed)/i.test(prev)) {
			out[out.length - 1] = `${prev},${trimmed}`;
		} else {
			out.push(trimmed);
		}
	}
	return out;
}

/**
 * Parses a normalized OSM `opening_hours` string into a {@link WeeklyHours}
 * table, or null when it uses grammar beyond the supported subset. Semantics
 * follow OSM: ";"-separated rules OVERRIDE the days they name, ","-separated
 * rules within one ";"-segment are ADDITIVE, a rule with no day selector
 * applies to all seven days, unmentioned days are closed, and "24/7" is open
 * around the clock. Holiday rules (PH/SH) are skipped, not failed — they say
 * nothing about the weekly table.
 */
export function parseOpeningHours(raw: string | null | undefined): WeeklyHours | null {
	const normalized = normalizeOpeningHours(raw);
	if (normalized === null) return null;
	if (normalized === '24/7') return ALL_DAYS.map(() => [[0, 1440] as HoursSpan]);

	const week: WeeklyHours = ALL_DAYS.map(() => []);
	let matchedAny = false;
	for (const segment of normalized.split(';')) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		if (HOLIDAY_ONLY_SEGMENT.test(trimmed)) continue;
		// Days already written by THIS segment append (its "," rules are
		// additive); the segment's first touch of a day overrides what earlier
		// ";" segments left there.
		const touched = new Set<number>();
		for (const rule of splitAdditiveRules(trimmed)) {
			const m = rule.match(RULE);
			if (!m) return null;
			const days = m[1] === undefined ? ALL_DAYS : parseDays(m[1]);
			if (days === null) return null;
			const body = m[2].trim().toLowerCase();
			const spans = body === 'off' || body === 'closed' ? [] : parseSpans(body);
			if (spans === null) return null;
			// Holiday-only selector inside a mixed segment: valid, nothing weekly.
			if (days.length === 0) continue;
			for (const d of days) {
				if (!touched.has(d)) {
					touched.add(d);
					week[d] = spans.slice();
				} else {
					week[d] = spans.length ? [...week[d], ...spans] : [];
				}
			}
			matchedAny = true;
		}
	}
	if (!matchedAny) return null;
	for (const day of week) day.sort((a, b) => a[0] - b[0]);
	return week;
}

/**
 * The canonical stored form of `locations.opening_hours_json`: the parsed
 * weekly table JSON-stringified, or null when the raw string is blank or
 * beyond the parsed subset. What every write path stores alongside the raw.
 */
export function weeklyHoursJson(raw: string | null | undefined): string | null {
	const week = parseOpeningHours(raw);
	return week === null ? null : JSON.stringify(week);
}

/**
 * Parses a stored `opening_hours_json` value back to {@link WeeklyHours},
 * defensively (a malformed blob renders as "no structured hours", never
 * throws). The client-side read of what {@link weeklyHoursJson} wrote.
 */
export function weeklyHoursFromJson(json: string | null | undefined): WeeklyHours | null {
	if (!json) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed) || parsed.length !== 7) return null;
		for (const day of parsed) {
			if (!Array.isArray(day)) return null;
			for (const span of day) {
				if (
					!Array.isArray(span) ||
					span.length !== 2 ||
					typeof span[0] !== 'number' ||
					typeof span[1] !== 'number'
				) {
					return null;
				}
			}
		}
		return parsed as WeeklyHours;
	} catch {
		return null;
	}
}

/** One display row: a run of consecutive days sharing the same spans. */
export interface HoursRow {
	/** Monday-first day indices, consecutive (e.g. [0,1,2,3,4] for Mo-Fr). */
	days: number[];
	/** The shared spans; empty = closed on those days. */
	spans: HoursSpan[];
}

/**
 * Groups a weekly table into display rows: consecutive days (Monday-first,
 * non-wrapping) with identical spans collapse into one row, so
 * "Mo-Fr 11:00-22:00 / Sa-Su closed" renders as two lines, not seven.
 */
export function groupWeeklyHours(week: WeeklyHours): HoursRow[] {
	const rows: HoursRow[] = [];
	for (let d = 0; d < 7; d++) {
		const prev = rows[rows.length - 1];
		if (prev && sameSpans(week[prev.days[0]], week[d])) prev.days.push(d);
		else rows.push({ days: [d], spans: week[d] });
	}
	return rows;
}

function sameSpans(a: HoursSpan[], b: HoursSpan[]): boolean {
	return a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1]);
}

// A fixed week starting on a Monday, rendered in UTC — day names and times go
// through Intl so every locale gets its own forms without message-catalog
// keys. 2024-01-01 was a Monday.
const MONDAY_UTC = Date.UTC(2024, 0, 1);

/** The locale's short weekday name for a Monday-first day index (0 = Mo). */
export function weekdayName(day: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		timeZone: 'UTC'
	}).format(MONDAY_UTC + day * 86_400_000);
}

/**
 * A minutes-since-midnight value as the locale's time-of-day string. An
 * overnight close past 1440 wraps — [660, 1560] renders as "11:00 a.m." and
 * "2:00 a.m.".
 */
export function formatMinutes(minutes: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC'
	}).format(MONDAY_UTC + (minutes % 1440) * 60_000);
}
