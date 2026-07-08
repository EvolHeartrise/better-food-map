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
			expect(formatPhone(raw, 'CA')?.display).toBe('(604) 555-1234');
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
		expect(formatPhone('6045551234')?.display).toBe('(604) 555-1234');
		expect(formatPhone('6045551234')?.e164).toBe('+16045551234');
	});

	test('keeps the extension in the display and the tel target', () => {
		const a = formatPhone('+1-416-922-2905x5', 'CA');
		expect(a?.display).toBe('(416) 922-2905 ext. 5');
		expect(a?.tel).toBe('+14169222905;ext=5');

		const b = formatPhone('+1 613-533-6000 x78283', 'CA');
		expect(b?.display).toBe('(613) 533-6000 ext. 78283');
		expect(b?.tel).toBe('+16135336000;ext=78283');

		expect(formatPhone('+1 613 533 6000 ext. 42', 'CA')?.display).toBe('(613) 533-6000 ext. 42');
	});

	test('takes the primary number from an OSM multi-value phone', () => {
		expect(formatPhone('+1-604-380-4665;+1-604-463-0278', 'CA')?.display).toBe('(604) 380-4665');
		expect(formatPhone('+1-604-380-4665;+1-604-463-0278', 'CA')?.tel).toBe('+16043804665');
	});

	test('round-trips its own canonical stored form', () => {
		expect(formatPhone('+16045551234', 'CA')?.display).toBe('(604) 555-1234');
		expect(formatPhone('+16045551234;ext=5', 'CA')?.display).toBe('(604) 555-1234 ext. 5');
		expect(formatPhone('+16045551234;ext=5', 'CA')?.tel).toBe('+16045551234;ext=5');
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
