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
// `brandWikidata` complements that with OSM's own chain identity: most chain
// POIs carry `brand:wikidata` (~99.7% for the big Canadian chains), which
// catches name variants no allowlist anticipated ("Tim Hortons Express") AND
// exposes mistags ("Second Cup" carrying the Starbucks QID — real data). A
// brand-tagged POI is accepted only on TWO-SIGNAL agreement — its name must
// also resemble an accepted name (normalized containment); when the signals
// disagree the POI stays unimported in `name_buckets`, annotated with its QID,
// for explicit vetting. Nothing is imported by surprise either way.
//
// The D1 insert (chunked through the same path as create_locations) stays in
// scripts/db-mcp-server.ts; this module is pure selection and unit-tested in
// import-chain.test.ts.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { haversineMeters } from './geo';
import { effectivePoiAddressParts, poiCountry } from './map-feature';
import {
	existingInBbox,
	isExistingDuplicate,
	namesMatch,
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
	 * Wikidata QID accepted as this chain's OSM `brand:wikidata` tag (e.g.
	 * "Q37158" for Starbucks). Also accepts POIs whose exact name is NOT in
	 * `nameMatch`, but only on two-signal agreement: the POI's name must still
	 * resemble an accepted name (normalized containment), so a mistagged POI
	 * ("Second Cup" carrying the Starbucks QID) is never absorbed — it stays in
	 * `name_buckets` with its QID annotation for explicit vetting.
	 */
	brandWikidata?: string;
	/**
	 * ISO-2 country scope (e.g. "CA"). Drops POIs whose address signals a
	 * different country before matching/bucketing; POIs with no country signal
	 * are kept. Guards border-spanning areas — a Canada extract carries some US
	 * border-town POIs that would otherwise import under the wrong country.
	 */
	country?: string;
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
	/**
	 * Dominant OSM `brand:wikidata` QID among this bucket's POIs, when any carry
	 * one — the vetting signal for unmatched buckets: a variant name carrying the
	 * chain's own QID is almost certainly a real branch, a foreign QID almost
	 * certainly is not.
	 */
	brand_wikidata?: string;
	/** How many of the bucket's POIs carry that dominant QID. */
	brand_wikidata_count?: number;
}

export interface ChainCandidateSelection {
	/** The POIs to import, nearest-first for a centre query else store order. */
	matched: StoredPoi[];
	/** Every distinct POI name the scans saw, largest bucket first. */
	name_buckets: NameBucket[];
	/** Matched POIs dropped because the venue is already on the map. */
	excluded_existing: number;
	/** POIs dropped because their address signals a different country (only with `country`). */
	excluded_foreign: number;
	/** POIs accepted via brand:wikidata agreement rather than an exact name match. */
	matched_by_brand: number;
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
	// The brand scan surfaces branches whose name no allowlist entry anticipated —
	// a name scan cannot find a "Tim Hortons Express" when the term is "Tim Hortons".
	if (params.brandWikidata) {
		const rows = store.searchBbox(bbox, { brand_wikidata: params.brandWikidata, cap });
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

	// Country scope: drop foreign-signalled POIs BEFORE bucketing, so a "Subway"
	// in a US border town neither imports nor pads the matched bucket's count.
	let excludedForeign = 0;
	if (params.country) {
		const scope = params.country.toUpperCase();
		pois = pois.filter((poi) => {
			const c = poiCountry(poi);
			if (c === null || c === scope) return true;
			excludedForeign++;
			return false;
		});
	}

	const acceptedList = [...accepted];
	const buckets = new Map<string, NameBucket>();
	const qidCounts = new Map<string, Map<string, number>>();
	const matchedRaw: StoredPoi[] = [];
	let matchedByBrand = 0;
	for (const poi of pois) {
		const name = poi.name ?? '(unnamed)';
		const norm = normalizeName(poi.name);
		const qid = brandWikidataOf(poi);
		const nameMatched = accepted.has(norm);
		// Two-signal acceptance: the chain's own QID plus a resembling name. A
		// conflicting name (a mistagged POI) keeps the POI out of the import.
		const brandMatched =
			!nameMatched &&
			params.brandWikidata !== undefined &&
			qid === params.brandWikidata &&
			acceptedList.some((a) => namesMatch(norm, a));
		const matched = nameMatched || brandMatched;
		const bucket = buckets.get(name);
		if (bucket) {
			bucket.count++;
			bucket.matched ||= matched;
		} else {
			buckets.set(name, { name, count: 1, matched });
		}
		if (qid) {
			const counts = qidCounts.get(name) ?? new Map<string, number>();
			counts.set(qid, (counts.get(qid) ?? 0) + 1);
			qidCounts.set(name, counts);
		}
		if (matched) matchedRaw.push(poi);
		if (brandMatched) matchedByBrand++;
	}

	const existing = matchedRaw.length ? await existingInBbox(db, bbox) : [];
	const matched: StoredPoi[] = [];
	let excludedExisting = 0;
	for (const poi of matchedRaw) {
		if (isExistingDuplicate(poi, existing)) excludedExisting++;
		else matched.push(poi);
	}

	const annotated = [...buckets.values()].map((bucket) => {
		const counts = qidCounts.get(bucket.name);
		if (!counts?.size) return bucket;
		const [qid, n] = [...counts.entries()].toSorted((x, y) => y[1] - x[1])[0];
		return { ...bucket, brand_wikidata: qid, brand_wikidata_count: n };
	});

	return {
		matched,
		name_buckets: annotated.toSorted((a, b) => b.count - a.count),
		excluded_existing: excludedExisting,
		excluded_foreign: excludedForeign,
		matched_by_brand: matchedByBrand,
		scan_truncated: scanTruncated
	};
}

/** The POI's OSM `brand:wikidata` QID, from its stored tag blob (null when absent/corrupt). */
function brandWikidataOf(poi: StoredPoi): string | null {
	try {
		const tags = JSON.parse(poi.tags_json) as Record<string, string>;
		const qid = tags['brand:wikidata'];
		return typeof qid === 'string' && qid.trim() ? qid.trim() : null;
	} catch {
		return null;
	}
}

/** Summary of the matched POIs a chain import cannot resolve an address for. */
export interface UnresolvableSummary {
	count: number;
	/** POIs with city/region but no recoverable street (the dominant case). */
	missing_street: number;
	/** POIs missing city and/or region even after every fallback (rare post-enrichment). */
	missing_city_or_region: number;
	/** Up to 15 example osm_ids, for spot checks / targeted enrichment. */
	sample_osm_ids: string[];
}

const UNRESOLVABLE_SAMPLE = 15;

/**
 * Splits matched POIs into those whose address is fully resolvable offline
 * (street + city + region through the same merged-parts chain the import path
 * uses) and a compact summary of the rest. The import cap (`max`) must be
 * applied to the IMPORTABLE list — slicing the raw matched list lets a long run
 * of street-less POIs occupy the window forever, making the valid branches
 * behind them unreachable no matter how often the call is repeated.
 */
export function partitionImportable(pois: StoredPoi[]): {
	importable: StoredPoi[];
	unresolvable: UnresolvableSummary;
} {
	const importable: StoredPoi[] = [];
	const unresolvable: UnresolvableSummary = {
		count: 0,
		missing_street: 0,
		missing_city_or_region: 0,
		sample_osm_ids: []
	};
	for (const poi of pois) {
		const parts = effectivePoiAddressParts(poi);
		if (parts?.street && parts.city && parts.region) {
			importable.push(poi);
			continue;
		}
		unresolvable.count++;
		if (parts?.street) unresolvable.missing_city_or_region++;
		else unresolvable.missing_street++;
		if (unresolvable.sample_osm_ids.length < UNRESOLVABLE_SAMPLE) {
			unresolvable.sample_osm_ids.push(poi.osm_id);
		}
	}
	return { importable, unresolvable };
}
