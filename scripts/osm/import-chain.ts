// ---------------------------------------------------------------------------
// import_chain candidate selection: everything deterministic about importing a
// chain's branches from the OSM staging store, short of the D1 insert itself.
//
// Importing a chain used to be an agent loop — search_poi page, hand-filter the
// name matches, batch create_locations, repeat until the store ran dry — which
// burned hundreds of tool calls per chain. Given (area, accepted source names),
// the whole selection is deterministic, so it lives here as one call: scan the
// store for each accepted name, union the hits, drop venues already on the map
// (same dedup rules as search_poi), and split the rest into exact-name matches
// to import vs a name histogram of everything else seen.
//
// Name matching is deliberately STRICT equality on normalized names (accents,
// punctuation and "&"/"and" folded — see normalizeName): fuzzy containment
// would silently absorb "Browns Social House - Harvey" into Harvey's. Instead,
// every non-matching name is reported with its count, so extending the
// allowlist is one dry-run away and nothing is imported by surprise.
//
// The D1 insert (chunked through the same path as create_locations) stays in
// scripts/db-mcp-server.ts; this module is pure selection and unit-tested in
// import-chain.test.ts.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { haversineMeters } from './geo';
import {
	existingInBbox,
	isExistingDuplicate,
	normalizeName,
	resolveArea,
	type SearchPoiParams
} from './search-poi';
import type { OsmPoiStore, StoredPoi } from './poi-store';

export interface SelectChainCandidatesParams {
	/** The query area — a bbox, or a centre + radius (same rules as search_poi). */
	area: Pick<SearchPoiParams, 'bbox' | 'latitude' | 'longitude' | 'radius_km'>;
	/**
	 * Source names accepted as this chain, matched by strict normalized equality
	 * (e.g. ["Harvey's", "Harveys"]). Names seen in the area but not matched are
	 * returned in `name_buckets` for allowlist iteration, never imported.
	 */
	nameMatch: string[];
	/**
	 * Rows scanned from the store per accepted name (default 20000) — far above
	 * any real chain's footprint, present only to bound a pathological scan.
	 */
	scanCap?: number;
}

/** How many POIs in the area carried one distinct source name, and its fate. */
export interface NameBucket {
	name: string;
	count: number;
	matched: boolean;
}

export interface ChainCandidateSelection {
	/** The POIs to import, nearest-first for a centre query else store order. */
	matched: StoredPoi[];
	/** Every distinct POI name the scans saw, largest bucket first. */
	name_buckets: NameBucket[];
	/** Matched POIs dropped because the venue is already on the map. */
	excluded_existing: number;
	/** True when a scan hit `scanCap` — results may be incomplete; narrow the area. */
	scan_truncated: boolean;
}

const DEFAULT_SCAN_CAP = 20_000;

/**
 * Selects the staging-store POIs that ARE this chain in the area: one bbox scan
 * per accepted name (unioned by osm_id), strict normalized-name filtering, then
 * the same already-on-the-map exclusion search_poi applies. Pure read — the
 * caller decides what to do with the selection (import, or preview via dry-run).
 */
export async function selectChainCandidates(
	store: OsmPoiStore,
	db: D1Like,
	params: SelectChainCandidatesParams
): Promise<ChainCandidateSelection> {
	const { bbox, centre } = resolveArea(params.area);
	const cap = params.scanCap ?? DEFAULT_SCAN_CAP;
	const accepted = new Set(params.nameMatch.map(normalizeName).filter(Boolean));

	// One indexed scan per accepted spelling; a POI matching several terms unions
	// to one row. The SQL name filter is a literal substring match, so a term is
	// also scanned with its apostrophes stripped — "Harvey's" must surface a POI
	// mapped as "Harveys" (the dominant spelling variant), which the normalized
	// equality below then accepts. Other variants need their own name_match entry.
	const scanTerms = new Set<string>();
	for (const term of params.nameMatch) {
		scanTerms.add(term);
		const noApostrophe = term.replace(/['‘’]/g, '');
		if (noApostrophe.trim()) scanTerms.add(noApostrophe);
	}
	const byId = new Map<string, StoredPoi>();
	let scanTruncated = false;
	for (const term of scanTerms) {
		const rows = store.searchBbox(bbox, { name: term, cap });
		if (rows.length >= cap) scanTruncated = true;
		for (const row of rows) byId.set(row.osm_id, row);
	}

	// Refine to the exact circle for a centre query, and order nearest-first so a
	// capped import takes the closest branches.
	let pois = [...byId.values()];
	if (centre) {
		const radiusM = centre.radiusKm * 1000;
		pois = pois
			.map((poi) => ({
				poi,
				d: haversineMeters(centre.lat, centre.lon, poi.latitude, poi.longitude)
			}))
			.filter((x) => x.d <= radiusM)
			.toSorted((a, b) => a.d - b.d)
			.map((x) => x.poi);
	}

	const buckets = new Map<string, NameBucket>();
	const matchedRaw: StoredPoi[] = [];
	for (const poi of pois) {
		const name = poi.name ?? '(unnamed)';
		const matched = accepted.has(normalizeName(poi.name));
		const bucket = buckets.get(name);
		if (bucket) bucket.count++;
		else buckets.set(name, { name, count: 1, matched });
		if (matched) matchedRaw.push(poi);
	}

	const existing = matchedRaw.length ? await existingInBbox(db, bbox) : [];
	const matched: StoredPoi[] = [];
	let excludedExisting = 0;
	for (const poi of matchedRaw) {
		if (isExistingDuplicate(poi, existing)) excludedExisting++;
		else matched.push(poi);
	}

	return {
		matched,
		name_buckets: [...buckets.values()].toSorted((a, b) => b.count - a.count),
		excluded_existing: excludedExisting,
		scan_truncated: scanTruncated
	};
}
