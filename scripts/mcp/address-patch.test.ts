/// <reference types="bun-types" />
// Tests normalizeAddressPatch (the address normalization behind the
// update_locations MCP tool). The key invariant: a patch that touches
// region/postcode WITHOUT a country validates against the row's STORED country
// (passed in by the handler), never the unscoped CA∪US fallback — so a
// region-only patch can't store a US state code on a country='CA' row.

import { test, expect } from 'bun:test';
import { normalizeAddressPatch } from './address-patch';

test('region-only patch validates against the stored country', () => {
	// A valid same-country region normalizes as usual (full name → code).
	expect(normalizeAddressPatch({ region: 'AB' }, 'CA')).toEqual({ region: 'AB' });
	expect(normalizeAddressPatch({ region: 'British Columbia' }, 'CA')).toEqual({ region: 'BC' });

	// A US-only state code on a CA row is rejected, not silently stored.
	expect(() => normalizeAddressPatch({ region: 'WA' }, 'CA')).toThrow(/for CA/);
	// And the mirror image: a CA province on a US row.
	expect(() => normalizeAddressPatch({ region: 'BC' }, 'US')).toThrow(/for US/);
});

test('a patch that also sets country validates against the NEW country, not the stored one', () => {
	expect(normalizeAddressPatch({ region: 'WA', country: 'US' }, 'CA')).toEqual({
		region: 'WA',
		country: 'US'
	});
	// Region conflicting with the patch's own country still fails.
	expect(() => normalizeAddressPatch({ region: 'WA', country: 'CA' }, 'US')).toThrow(/for CA/);
});

test('postcode patches are scoped to the stored country', () => {
	expect(normalizeAddressPatch({ postcode: 'v6j1m5' }, 'CA')).toEqual({ postcode: 'V6J 1M5' });
	expect(normalizeAddressPatch({ postcode: '98101' }, 'US')).toEqual({ postcode: '98101' });
	// A US ZIP on a CA row is invalid rather than stored cross-country.
	expect(() => normalizeAddressPatch({ postcode: '98101' }, 'CA')).toThrow(/CA postal\/ZIP/);
	expect(() => normalizeAddressPatch({ postcode: 'V6J 1M5' }, 'US')).toThrow(/US postal\/ZIP/);
	// null / '' still clear the postcode regardless of country.
	expect(normalizeAddressPatch({ postcode: null }, 'CA')).toEqual({ postcode: null });
	expect(normalizeAddressPatch({ postcode: '' }, 'US')).toEqual({ postcode: null });
});

test('without any country (no patch country, no stored row) the CA∪US fallback still resolves', () => {
	expect(normalizeAddressPatch({ region: 'BC' })).toEqual({ region: 'BC' });
	expect(normalizeAddressPatch({ region: 'WA' })).toEqual({ region: 'WA' });
	expect(() => normalizeAddressPatch({ region: 'ZZ' })).toThrow(/not a recognized/);
});

test('untouched parts pass through and unrelated fields are trimmed as before', () => {
	expect(normalizeAddressPatch({ street: ' 1 Test St ', city: ' Vancouver ' }, 'CA')).toEqual({
		street: '1 Test St',
		city: 'Vancouver'
	});
	expect(normalizeAddressPatch({}, 'CA')).toEqual({});
	expect(() => normalizeAddressPatch({ country: 'Narnia' }, 'CA')).toThrow(
		/not a recognized country/
	);
});
