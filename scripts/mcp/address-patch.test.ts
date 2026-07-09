/// <reference types="bun-types" />
// Tests normalizeAddressParts (the CREATE-path address normalization behind
// create_locations / import_chain) and normalizeAddressPatch (the address
// normalization behind the update_locations MCP tool). The key PATCH invariant:
// a patch that touches region/postcode WITHOUT a country validates against the
// row's STORED country (passed in by the handler), never the unscoped CA∪US
// fallback — so a region-only patch can't store a US state code on a
// country='CA' row.

import { test, expect } from 'bun:test';
import { normalizeAddressParts, normalizeAddressPatch } from './address-patch';

// ---------------------------------------------------------------------------
// normalizeAddressParts (create path)
// ---------------------------------------------------------------------------

/** Collects warnings so each test can assert on drops without a mock library. */
function collectWarnings(): { warn: (m: string) => void; warnings: string[] } {
	const warnings: string[] = [];
	return { warn: (m) => warnings.push(m), warnings };
}

test('create path normalizes region/country spellings to stored codes', () => {
	const { warn, warnings } = collectWarnings();
	expect(
		normalizeAddressParts(
			{ street: ' 1909 W 4th Ave ', city: ' Vancouver ', region: 'British Columbia' },
			warn
		)
	).toEqual({
		street: '1909 W 4th Ave',
		city: 'Vancouver',
		region: 'BC',
		postcode: null,
		country: 'CA' // country defaults to CA when omitted
	});
	// A country name normalizes to its ISO-2 code and scopes the region lookup.
	expect(
		normalizeAddressParts(
			{ street: '1 Pike Pl', city: 'Seattle', region: 'Washington', country: 'United States' },
			warn
		)
	).toEqual({
		street: '1 Pike Pl',
		city: 'Seattle',
		region: 'WA',
		postcode: null,
		country: 'US'
	});
	expect(warnings).toEqual([]);
});

test('create path rejects a region that does not belong to the record country', () => {
	const { warn } = collectWarnings();
	// US state on the defaulted-CA record: the error nudges toward passing country.
	expect(() =>
		normalizeAddressParts({ street: '1 Pike Pl', city: 'Seattle', region: 'WA' }, warn)
	).toThrow(/for CA.*country defaulted to CA/s);
	// With an explicit country, the same mismatch fails without the defaulting hint.
	expect(() =>
		normalizeAddressParts(
			{ street: '123 Main St', city: 'Calgary', region: 'BC', country: 'US' },
			warn
		)
	).toThrow(/for US\./);
});

test('create path normalizes a valid postcode for the record country', () => {
	const { warn, warnings } = collectWarnings();
	expect(
		normalizeAddressParts(
			{ street: '1 Test St', city: 'Vancouver', region: 'BC', postcode: 'v6j1m5' },
			warn
		).postcode
	).toBe('V6J 1M5');
	expect(
		normalizeAddressParts(
			{ street: '1 Pike Pl', city: 'Seattle', region: 'WA', postcode: '98101', country: 'US' },
			warn
		).postcode
	).toBe('98101');
	expect(warnings).toEqual([]);
});

test('create path DROPS a partial/invalid postcode with a warning instead of failing', () => {
	const { warn, warnings } = collectWarnings();
	// A bare FSA (half a CA postal code) is dropped, not stored (the stated policy).
	const result = normalizeAddressParts(
		{ street: '1 Test St', city: 'Edmonton', region: 'AB', postcode: 'T5R' },
		warn
	);
	expect(result.postcode).toBeNull();
	expect(warnings).toEqual([expect.stringContaining('"T5R" is not a valid CA postal/ZIP code')]);
	// A cross-country postcode is equally invalid for the record's country.
	const { warn: warn2, warnings: warnings2 } = collectWarnings();
	expect(
		normalizeAddressParts(
			{ street: '1 Test St', city: 'Vancouver', region: 'BC', postcode: '98101' },
			warn2
		).postcode
	).toBeNull();
	expect(warnings2).toHaveLength(1);
});

test('create path treats a missing/blank postcode as absent, without a warning', () => {
	const { warn, warnings } = collectWarnings();
	const base = { street: '1 Test St', city: 'Vancouver', region: 'BC' };
	expect(normalizeAddressParts(base, warn).postcode).toBeNull();
	expect(normalizeAddressParts({ ...base, postcode: null }, warn).postcode).toBeNull();
	expect(normalizeAddressParts({ ...base, postcode: '  ' }, warn).postcode).toBeNull();
	expect(warnings).toEqual([]);
});

// ---------------------------------------------------------------------------
// normalizeAddressPatch (update path)
// ---------------------------------------------------------------------------

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
