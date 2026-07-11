// ---------------------------------------------------------------------------
// unlinked_chain_branch audit: INDEPENDENT venues (brand_id IS NULL) whose name
// matches an existing chain — a venue that IS a branch of the chain but was
// never linked to it, so it serves a stale hand-curated private menu instead of
// the shared chain menu every real branch shows (issue #242's stray A&W at
// 12133 72 Ave, Surrey).
//
// How they arise: import_chain dedups each staging POI against the venues
// already on the map, so a pre-existing independent venue at a chain's spot is
// EXCLUDED from the import — correctly avoiding a duplicate pin — but it is left
// independent and un-adopted. duplicate_locations cannot catch it: the import
// created no second row, so there is no pair to flag. This audit closes that gap
// by name-matching independents against the brand table directly.
//
// The match reuses the SAME normalizeName / namesMatch as import_chain's own
// dedup, so a flagged venue is exactly one import_chain would have deduped
// against — verify against the chain's locator, then adopt with update_locations
// (set brand_id + menu_id to the shared menu) and delete its private menu, or
// delete_locations it if it is a bad row. Only OPEN venues are flagged (a closed
// tombstone is hidden from the map and need not be adopted). Reads only the live
// D1, like find-html-entities.
// ---------------------------------------------------------------------------

import { formatAddress } from '../../src/lib/address';
import { DismissFilter, type DismissableFinding, type DismissalOpts } from './audit-dismiss';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, clampLimit, pageFindings } from './paging';
import { namesMatch, normalizeName } from './search-poi';
import type { D1Like } from '../../src/lib/server/db';

/** One independent venue that looks like an unlinked branch of `brand`. */
export interface UnlinkedChainBranch extends DismissableFinding {
	/** The venue's id — pass to update_locations to adopt it onto the chain. */
	id: string;
	name: string;
	/** Canonical single-line display address (derived, never stored). */
	address: string;
	/** The venue's private menu id (delete after adopting, or check its staleness). */
	menu_id: string | null;
	/** How many items sit on that private menu (the stale, out-of-sync menu). */
	item_count: number;
	/** The chain its name matches — adopt onto this brand's shared menu. */
	brand: { id: string; name: string };
}

export interface FindUnlinkedChainBranchesResult {
	/** Flagged independents, brand then name ordered, capped at `limit`. */
	unlinked: UnlinkedChainBranch[];
	/** Full flagged count before `limit`. */
	total: number;
	/** How many of them this result carries (≤ total). */
	returned: number;
	/** Flagged venues NOT returned because of `limit` (total - returned). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
}

/**
 * Flags every OPEN independent venue (brand_id IS NULL) whose normalized name
 * matches a chain in the brands table — a branch that was never linked to its
 * chain and so serves a stale private menu. `limit` (default 50, max 200) caps
 * the returned list, with anything cut counted in `additional`.
 */
export async function findUnlinkedChainBranches(
	db: D1Like,
	opts: { limit?: number } & DismissalOpts = {}
): Promise<FindUnlinkedChainBranchesResult> {
	const limit = clampLimit(opts.limit, { def: DEFAULT_PAGE_LIMIT, min: 1, max: MAX_PAGE_LIMIT });
	const filter = new DismissFilter(opts);

	const [brandRows, locationRows] = await Promise.all([
		// ORDER BY makes the first-match rule (and so the dismissal fingerprint)
		// stable across runs — unordered SELECTs may reorder after a vacuum/import.
		db.prepare(`SELECT id, name FROM brands ORDER BY id`).all<{ id: string; name: string }>(),
		db
			.prepare(
				`SELECT id, name, street, city, region, postcode, menu_id FROM locations
				 WHERE brand_id IS NULL AND closed_at IS NULL
				 ORDER BY name`
			)
			.all<{
				id: string;
				name: string;
				street: string;
				city: string;
				region: string;
				postcode: string | null;
				menu_id: string | null;
			}>()
	]);

	// Pre-normalize the brands once; skip any that normalize to empty.
	const brands = brandRows.results
		.map((b) => ({ id: b.id, name: b.name, norm: normalizeName(b.name) }))
		.filter((b) => b.norm !== '');

	const flagged: Omit<UnlinkedChainBranch, 'item_count'>[] = [];
	for (const loc of locationRows.results) {
		const norm = normalizeName(loc.name);
		if (norm === '') continue;
		// First matching brand wins — a venue name matching two brands is a data
		// oddity worth surfacing under either; deterministic order (brand id).
		const brand = brands.find((b) => namesMatch(norm, b.norm));
		if (!brand) continue;
		// A dismissal says this venue is genuinely independent despite the name
		// (e.g. an unaffiliated namesake); matching a DIFFERENT chain is new evidence.
		const decision = filter.evaluate(loc.id, brand.id);
		if (decision.drop) continue;
		flagged.push({
			id: loc.id,
			name: loc.name,
			address: formatAddress({
				street: loc.street,
				city: loc.city,
				region: loc.region,
				postcode: loc.postcode
			}),
			menu_id: loc.menu_id,
			brand: { id: brand.id, name: brand.name },
			...decision.fields
		});
	}

	const { page: returnedFlagged, tail } = pageFindings(flagged, {
		limit,
		suppressed: filter.suppressed
	});

	// Item counts for the returned venues' private menus (the stale-menu size).
	const menuIds = [
		...new Set(returnedFlagged.map((f) => f.menu_id).filter((m): m is string => !!m))
	];
	const itemCounts = new Map<string, number>();
	if (menuIds.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT menu_id, COUNT(*) AS n FROM items
				 WHERE menu_id IN (SELECT value FROM json_each(?)) GROUP BY menu_id`
			)
			.bind(JSON.stringify(menuIds))
			.all<{ menu_id: string; n: number }>();
		for (const row of results) itemCounts.set(row.menu_id, row.n);
	}

	const unlinked: UnlinkedChainBranch[] = returnedFlagged.map((f) => ({
		...f,
		item_count: f.menu_id ? (itemCounts.get(f.menu_id) ?? 0) : 0
	}));

	return { unlinked, ...tail };
}
