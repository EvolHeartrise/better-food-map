// Address-part normalization for the update_locations PATCH path. Kept in its
// own module so it is unit-testable without importing db-mcp-server.ts (which
// connects a stdio transport on import). The CREATE-path counterpart
// (normalizeAddressParts) lives in db-mcp-server.ts.

import { normalizeRegion, normalizePostcode, normalizeCountry } from '../../src/lib/address';

/**
 * Normalizes only the address parts PRESENT in an update patch (a partial update
 * may touch just one part). region/postcode are validated against the patch's
 * country when given, else against `storedCountry` — the row's stored country,
 * which the update_locations handler looks up — so a region-only patch can never
 * store another country's state code (e.g. `region: 'WA'` on a country='CA' row),
 * mirroring how the create path always scopes to the record's country.
 * Throws on an unresolvable value; `postcode: null`/'' clears it.
 */
export function normalizeAddressPatch(
	patch: {
		street?: string;
		city?: string;
		region?: string;
		postcode?: string | null;
		country?: string;
	},
	storedCountry?: string | null
): Partial<{
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
}> {
	const out: Partial<{
		street: string;
		city: string;
		region: string;
		postcode: string | null;
		country: string;
	}> = {};
	if (patch.country !== undefined) {
		const c = normalizeCountry(patch.country);
		if (!c) throw new Error(`country "${patch.country}" is not a recognized country.`);
		out.country = c;
	}
	if (patch.street !== undefined) out.street = patch.street.trim();
	if (patch.city !== undefined) out.city = patch.city.trim();
	// The country the patched row will END UP with: the patch's own country when it
	// sets one, else the row's stored country. Region/postcode must validate against
	// it — never against the unscoped CA∪US fallback, which would happily store a US
	// state code on a CA row.
	const country = out.country ?? normalizeCountry(storedCountry) ?? undefined;
	if (patch.region !== undefined) {
		const r = normalizeRegion(patch.region, country);
		if (!r) {
			throw new Error(
				`region "${patch.region}" is not a recognized province/state` +
					(country ? ` for ${country} (the location's country — pass country to change it)` : '') +
					'.'
			);
		}
		out.region = r;
	}
	if (patch.postcode !== undefined) {
		if (patch.postcode === null || patch.postcode.trim() === '') {
			out.postcode = null;
		} else {
			const p = normalizePostcode(patch.postcode, country);
			if (!p) {
				throw new Error(
					`postcode "${patch.postcode}" is not a valid` +
						(country ? ` ${country}` : '') +
						' postal/ZIP code.'
				);
			}
			out.postcode = p;
		}
	}
	return out;
}
