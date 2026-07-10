import { expect, test, describe } from 'bun:test';
import {
	OPENING_HOURS_MAX_LEN,
	formatMinutes,
	groupWeeklyHours,
	normalizeOpeningHours,
	parseOpeningHours,
	weekdayName,
	weeklyHoursFromJson,
	weeklyHoursJson,
	type WeeklyHours
} from '../src/lib/opening-hours';

const CLOSED_WEEK: WeeklyHours = [[], [], [], [], [], [], []];

/** Unwraps a nullable parse/serialize result, failing the test loudly. */
function must<T>(value: T | null): T {
	if (value === null) throw new Error('expected a non-null value');
	return value;
}

function week(overrides: Partial<Record<number, [number, number][]>>): WeeklyHours {
	return CLOSED_WEEK.map((_, d) => overrides[d] ?? []);
}

describe('normalizeOpeningHours', () => {
	test('canonicalizes unicode dashes, NBSP and whitespace runs', () => {
		expect(normalizeOpeningHours('Tu–We 09:00–15:00')).toBe('Tu-We 09:00-15:00');
		expect(normalizeOpeningHours('  Mo-Fr   08:00-18:00 ; ')).toBe('Mo-Fr 08:00-18:00');
	});

	test('drops blank, oversized and control-character input', () => {
		expect(normalizeOpeningHours(null)).toBeNull();
		expect(normalizeOpeningHours('   ')).toBeNull();
		expect(normalizeOpeningHours('Mo-Fr 08:00-18:00')).toBeNull();
		expect(normalizeOpeningHours('x'.repeat(OPENING_HOURS_MAX_LEN + 1))).toBeNull();
	});
});

describe('parseOpeningHours', () => {
	test('single all-week rule', () => {
		expect(parseOpeningHours('Mo-Su 11:00-23:30')).toEqual(
			week({
				0: [[660, 1410]],
				1: [[660, 1410]],
				2: [[660, 1410]],
				3: [[660, 1410]],
				4: [[660, 1410]],
				5: [[660, 1410]],
				6: [[660, 1410]]
			})
		);
	});

	test('semicolon rules override the days they name; unmentioned days stay closed', () => {
		expect(parseOpeningHours('Mo-Sa 05:30-21:00; Su 05:30-20:00')).toEqual(
			week({
				0: [[330, 1260]],
				1: [[330, 1260]],
				2: [[330, 1260]],
				3: [[330, 1260]],
				4: [[330, 1260]],
				5: [[330, 1260]],
				6: [[330, 1200]]
			})
		);
		expect(parseOpeningHours('Tu-Su 17:00-22:00')?.[0]).toEqual([]);
	});

	test('comma-separated additive rules with day lists (the classic multi-rule line)', () => {
		expect(parseOpeningHours('Mo-Th 10:30-22:30, Fr,Sa 10:30-24:00, Su 11:00-22:00')).toEqual(
			week({
				0: [[630, 1350]],
				1: [[630, 1350]],
				2: [[630, 1350]],
				3: [[630, 1350]],
				4: [[630, 1440]],
				5: [[630, 1440]],
				6: [[660, 1320]]
			})
		);
	});

	test('comma rules ADD spans to a day already set in the same segment (split lunch/dinner)', () => {
		expect(
			parseOpeningHours(
				'We-Fr 11:00-14:00, We,Th 17:00-21:00, Fr 17:00-22:00, Sa 17:00-22:00, Su 11:00-14:00'
			)
		).toEqual(
			week({
				2: [
					[660, 840],
					[1020, 1260]
				],
				3: [
					[660, 840],
					[1020, 1260]
				],
				4: [
					[660, 840],
					[1020, 1320]
				],
				5: [[1020, 1320]],
				6: [[660, 840]]
			})
		);
	});

	test('multiple spans per day inside one rule', () => {
		expect(parseOpeningHours('Mo-Fr 11:00-14:00,17:00-21:00')?.[0]).toEqual([
			[660, 840],
			[1020, 1260]
		]);
	});

	test('day ranges wrap across the week boundary', () => {
		const su_th = must(parseOpeningHours('Su-Th 12:00-22:00; Fr-Sa 12:00-22:30'));
		expect(su_th[6]).toEqual([[720, 1320]]); // Su
		expect(su_th[0]).toEqual([[720, 1320]]); // Mo
		expect(su_th[4]).toEqual([[720, 1350]]); // Fr
	});

	test('overnight closes extend past 1440', () => {
		expect(parseOpeningHours('Su-Tu 11:00-02:00')?.[6]).toEqual([[660, 1560]]);
		// close == open means 24h from the open (OSM semantics)
		expect(parseOpeningHours('Mo 11:00-11:00')?.[0]).toEqual([[660, 2100]]);
	});

	test('off/closed day rules and 24/7', () => {
		const w = must(parseOpeningHours('Mo-Sa 09:00-17:00; Su off'));
		expect(w[6]).toEqual([]);
		expect(parseOpeningHours('Tu-Su 10:00-18:00; Mo closed')?.[0]).toEqual([]);
		expect(parseOpeningHours('24/7')).toEqual(
			week({
				0: [[0, 1440]],
				1: [[0, 1440]],
				2: [[0, 1440]],
				3: [[0, 1440]],
				4: [[0, 1440]],
				5: [[0, 1440]],
				6: [[0, 1440]]
			})
		);
	});

	test('a rule with no day selector applies to all seven days', () => {
		const w = must(parseOpeningHours('05:00-20:00; Sa,Su 06:00-19:00'));
		expect(w[0]).toEqual([[300, 1200]]);
		expect(w[5]).toEqual([[360, 1140]]);
		expect(w[6]).toEqual([[360, 1140]]);
	});

	test('holiday (PH/SH) rules are tolerated and skipped, in every position', () => {
		expect(parseOpeningHours('Mo-Fr 11:00-20:00; PH off')?.[0]).toEqual([[660, 1200]]);
		expect(parseOpeningHours('Mo-We,Su 10:00-02:00; Th-Sa 10:00-03:00; PH unknown')?.[6]).toEqual([
			[600, 1560]
		]);
		// PH inside a day list applies the rule to the real days only
		expect(parseOpeningHours('Mo-Th,Su 12:00-20:00; Fr,Sa,PH 12:00-22:00')?.[4]).toEqual([
			[720, 1320]
		]);
		expect(parseOpeningHours('Mo-Th 10:30-17:30; Fr 10:30-16:00; Sa-Su,PH off')?.[5]).toEqual([]);
	});

	test('a string that is ONLY holiday rules carries no weekly information', () => {
		expect(parseOpeningHours('PH off')).toBeNull();
	});

	test('en-dash day ranges and HH.MM times normalize before parsing', () => {
		expect(parseOpeningHours('Tu–We 09:00–15:00; Th–Sa 09:00–20:00')?.[1]).toEqual([[540, 900]]);
		expect(parseOpeningHours('Mo-Fr 08.30-17.00')?.[0]).toEqual([[510, 1020]]);
	});

	test('grammar beyond the subset returns null (raw-string fallback)', () => {
		expect(parseOpeningHours('Mo-Fr 08:00-19:00; Dec 25 off')).toBeNull();
		expect(parseOpeningHours('Mo-Su sunrise-sunset')).toBeNull();
		expect(parseOpeningHours('Fr-Sa 17:00+')).toBeNull();
		expect(parseOpeningHours('Mo-Fr 08:00-18:00 "kitchen closes 17:00"')).toBeNull();
		expect(parseOpeningHours('Mo-off; Tu-off; We-15:00-23:00')).toBeNull();
		expect(parseOpeningHours('not hours at all')).toBeNull();
	});

	test('implausible times are rejected, not clamped', () => {
		expect(parseOpeningHours('Mo 09:00-17:75')).toBeNull();
		expect(parseOpeningHours('Mo 55:00-60:00')).toBeNull();
	});
});

describe('weeklyHoursJson / weeklyHoursFromJson', () => {
	test('round-trips the parsed table', () => {
		const json = must(weeklyHoursJson('Mo-Fr 09:00-17:00; Sa 10:00-14:00'));
		expect(weeklyHoursFromJson(json)).toEqual(
			parseOpeningHours('Mo-Fr 09:00-17:00; Sa 10:00-14:00')
		);
	});

	test('null for unparseable raw and defensive on malformed stored blobs', () => {
		expect(weeklyHoursJson('Mo-Su sunrise-sunset')).toBeNull();
		expect(weeklyHoursFromJson(null)).toBeNull();
		expect(weeklyHoursFromJson('not json')).toBeNull();
		expect(weeklyHoursFromJson('[[]]')).toBeNull(); // wrong day count
		expect(weeklyHoursFromJson('[[["9"]],[],[],[],[],[],[]]')).toBeNull();
	});
});

describe('groupWeeklyHours', () => {
	test('collapses consecutive same-hours days into one row', () => {
		const rows = groupWeeklyHours(must(parseOpeningHours('Mo-Fr 09:00-17:00; Sa-Su off')));
		expect(rows).toEqual([
			{ days: [0, 1, 2, 3, 4], spans: [[540, 1020]] },
			{ days: [5, 6], spans: [] }
		]);
	});

	test('does not merge non-consecutive days (only the Sa+Su closed pair collapses)', () => {
		const rows = groupWeeklyHours(must(parseOpeningHours('Mo,We,Fr 09:00-17:00; Tu,Th,Sa,Su off')));
		expect(rows.map((r) => r.days)).toEqual([[0], [1], [2], [3], [4], [5, 6]]);
	});
});

describe('Intl rendering helpers', () => {
	test('weekday names are Monday-first and locale-aware', () => {
		expect(weekdayName(0, 'en-US')).toBe('Mon');
		expect(weekdayName(6, 'en-US')).toBe('Sun');
		expect(weekdayName(0, 'fr-CA').toLowerCase().startsWith('lun')).toBe(true);
	});

	test('minutes render as locale times and overnight closes wrap', () => {
		expect(formatMinutes(660, 'en-US')).toMatch(/11:00/);
		expect(formatMinutes(1560, 'en-US')).toMatch(/2:00/); // [660,1560] close = 2 AM next day
	});
});
