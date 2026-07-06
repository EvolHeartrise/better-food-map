// Address-part normalization for the MCP server's write paths — the CREATE path
// (normalizeAddressParts: create_locations / import_chain) and the update_locations
// PATCH path (normalizeAddressPatch) — split out of the large server file into a
// focused, directly unit-testable module.

import { normalizeRegion, normalizePostcode, normalizeCountry } from '../../src/lib/address';

/**
 * Normalizes raw structured address args into the stored parts, throwing a clear
 * MCP error when a required part cannot be resolved. An invalid/partial postcode
 * is DROPPED with a warning rather than failing the whole record (the stated
 * policy: a half code is worse than none) — sources routinely carry a bare FSA,
 * and one bad optional part must not sink an otherwise-importable venue. Reused
 * by create_locations and import_chain so storage stays uniform regardless of
 * how a source spelled a province / postcode / country.
 */
export function normalizeAddressParts(
	args: {
		street: string;
		city: string;
		region: string;
		postcode?: string | null;
		country?: string | null;
	},
	warn: (message: string) => void
): {
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
} {
	const country = normalizeCountry(args.country ?? 'CA') ?? 'CA';
	const region = normalizeRegion(args.region, country);
	if (!region) {
		throw new Error(
			`region "${args.region}" is not a recognized province/state for ${country}. ` +
				'Pass a 2-letter code or full name' +
				(args.country === null || args.country === undefined
					? ` (country defaulted to ${country}; if this venue is elsewhere, pass its country too).`
					: '.')
		);
	}
	let postcode: string | null = null;
	if (args.postcode && args.postcode.trim()) {
		postcode = normalizePostcode(args.postcode, country);
		if (!postcode) {
			warn(
				`postcode "${args.postcode}" is not a valid ${country} postal/ZIP code — dropped ` +
					'(a partial code is worse than none); the location was still created.'
			);
		}
	}
	return {
		street: args.street.trim(),
		city: args.city.trim(),
		region,
		postcode,
		country
	};
}

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
