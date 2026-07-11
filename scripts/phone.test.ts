import { expect, test, describe } from 'bun:test';
import { formatPhone, normalizePhone } from '../src/lib/phone';

describe('formatPhone', () => {
	test('renders every NANP source spelling as the same display', () => {
		for (const raw of [
			'+1-604-555-1234',
			'+1 604 555 1234',
			'+16045551234',
			'(604) 555-1234',
			'604-555-1234',
			'604.555.1234',
			'1-604-555-1234'
		]) {
			expect(formatPhone(raw, 'CA')?.display).toBe('+1 (604) 555-1234');
		}
	});

	test('the tel dial target is the fully-qualified E.164 regardless of source form', () => {
		expect(formatPhone('(604) 555-1234', 'CA')?.tel).toBe('+16045551234');
		expect(formatPhone('+1 604 555 1234')?.tel).toBe('+16045551234');
	});

	test('exposes the E.164 for schema.org telephone', () => {
		expect(formatPhone('604-555-1234', 'CA')?.e164).toBe('+16045551234');
	});

	test('defaults a bare 10-digit number to NANP without a country', () => {
		expect(formatPhone('6045551234')?.display).toBe('+1 (604) 555-1234');
		expect(formatPhone('6045551234')?.e164).toBe('+16045551234');
	});

	test('returns the extension separately (number in display, ext for a localized label)', () => {
		const a = formatPhone('+1-416-922-2905x5', 'CA');
		expect(a?.display).toBe('+1 (416) 922-2905');
		expect(a?.extension).toBe('5');
		expect(a?.tel).toBe('+14169222905;ext=5');

		const b = formatPhone('+1 613-533-6000 x78283', 'CA');
		expect(b?.display).toBe('+1 (613) 533-6000');
		expect(b?.extension).toBe('78283');
		expect(b?.tel).toBe('+16135336000;ext=78283');

		const c = formatPhone('+1 613 533 6000 extension 42', 'CA');
		expect(c?.display).toBe('+1 (613) 533-6000');
		expect(c?.extension).toBe('42');
	});

	test('a number with no extension has extension null', () => {
		expect(formatPhone('(604) 555-1234', 'CA')?.extension).toBeNull();
	});

	test('takes the primary number from an OSM multi-value phone', () => {
		const p = formatPhone('+1-604-380-4665;+1-604-463-0278', 'CA');
		expect(p?.display).toBe('+1 (604) 380-4665');
		expect(p?.tel).toBe('+16043804665');
		expect(p?.extension).toBeNull();
	});

	test('multi-value + extension on the PRIMARY number keeps them together, drops the rest', () => {
		// Regression: the extension must be pulled from the primary segment AFTER the
		// multi-value split, never folded into the digits (would corrupt the E.164).
		const p = formatPhone('+1-416-922-2905x5;+1-604-463-0278', 'CA');
		expect(p?.display).toBe('+1 (416) 922-2905');
		expect(p?.extension).toBe('5');
		expect(p?.tel).toBe('+14169222905;ext=5');
		expect(p?.e164).toBe('+14169222905');
	});

	test('an extension on a SECOND number is dropped with that number', () => {
		const p = formatPhone('+1-604-380-4665;+1-604-463-0278x5', 'CA');
		expect(p?.display).toBe('+1 (604) 380-4665');
		expect(p?.extension).toBeNull();
		expect(p?.tel).toBe('+16043804665');
	});

	test('round-trips its own canonical stored form', () => {
		expect(formatPhone('+16045551234', 'CA')?.display).toBe('+1 (604) 555-1234');
		const withExt = formatPhone('+16045551234;ext=5', 'CA');
		expect(withExt?.display).toBe('+1 (604) 555-1234');
		expect(withExt?.extension).toBe('5');
		expect(withExt?.tel).toBe('+16045551234;ext=5');
	});

	test('keeps a non-NANP international number in E.164', () => {
		const uk = formatPhone('+44 20 7946 0018', 'GB');
		expect(uk?.display).toBe('+442079460018');
		expect(uk?.e164).toBe('+442079460018');
		expect(uk?.tel).toBe('+442079460018');
	});

	test('returns null for empty / digit-free input', () => {
		expect(formatPhone(null)).toBeNull();
		expect(formatPhone('')).toBeNull();
		expect(formatPhone('   ')).toBeNull();
		expect(formatPhone('call us!')).toBeNull();
	});
});

describe('normalizePhone', () => {
	test('collapses every NANP spelling to one canonical E.164', () => {
		for (const raw of [
			'+1-604-555-1234',
			'+1 604 555 1234',
			'+16045551234',
			'(604) 555-1234',
			'604-555-1234',
			'1-604-555-1234'
		]) {
			expect(normalizePhone(raw, 'CA')).toBe('+16045551234');
		}
	});

	test('preserves an extension as an RFC-3966 ;ext= suffix', () => {
		expect(normalizePhone('+1-416-922-2905x5', 'CA')).toBe('+14169222905;ext=5');
		expect(normalizePhone('+1 613-533-6000 x78283', 'CA')).toBe('+16135336000;ext=78283');
	});

	test('reduces an OSM multi-value phone to its primary number', () => {
		expect(normalizePhone('+1-604-380-4665;+1-604-463-0278', 'CA')).toBe('+16043804665');
	});

	test('multi-value + primary extension does not corrupt the stored E.164', () => {
		// Regression: previously folded the "5" into the digits → +141692229055 garbage.
		expect(normalizePhone('+1-416-922-2905x5;+1-604-463-0278', 'CA')).toBe('+14169222905;ext=5');
		expect(normalizePhone('+1-604-380-4665;+1-604-463-0278x5', 'CA')).toBe('+16043804665');
	});

	test('is idempotent on already-canonical input', () => {
		expect(normalizePhone('+16045551234', 'CA')).toBe('+16045551234');
		expect(normalizePhone('+16045551234;ext=5', 'CA')).toBe('+16045551234;ext=5');
	});

	test('keeps a non-NANP international number in E.164', () => {
		expect(normalizePhone('+44 20 7946 0018', 'GB')).toBe('+442079460018');
	});

	test('returns null for empty / digit-free input', () => {
		expect(normalizePhone(null)).toBeNull();
		expect(normalizePhone('  ')).toBeNull();
		expect(normalizePhone('n/a')).toBeNull();
	});
});
