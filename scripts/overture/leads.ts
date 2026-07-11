// ---------------------------------------------------------------------------
// Pure build logic for the Overture leads pool (runner: build-leads.ts).
//
// A LEAD is a Canadian Overture eatery (confidence >= 0.85) with NO name-related
// OSM staging POI within 500 m — the 2026-07-10 comparison experiment
// (compare-osm-eateries.ts) sized this coverage gap at ~45k rows, heavily chain
// units OSM rarely maps. The matched set showed ~1.19 Overture rows per real
// venue, so the raw pool carries ~16%+ internal duplication: near-duplicate
// leads (name-related within ~150 m) are collapsed to their highest-confidence
// representative, with `dup_count` recording how many rows collapsed.
//
// A lead is a RESEARCH CANDIDATE only — its Overture coordinates/address are
// never imported (CLAUDE.md: location coordinates must be OSM-based).
// ---------------------------------------------------------------------------

import { bboxAround, haversineMeters, SpatialGrid } from '../osm/geo';
import { normalizeName } from '../osm/search-poi';
import { ovBucket, primaryDataset, type OvertureEateryRow } from './eateries';
import { nameRelated } from './match-overture';

/** Minimum Overture confidence for the pool (the experiment's hi-conf tier). */
export const LEAD_MIN_CONFIDENCE = 0.85;
/** A lead must have no name-related staging POI within this radius (as in the experiment). */
export const OSM_MATCH_RADIUS_M = 500;
/** Name-related survivors within this radius collapse to one lead. */
export const LEAD_DEDUP_RADIUS_M = 150;

// Cell ≈ 555 m — larger than either probe radius, so a query touches few cells.
const CELL_DEG = 0.005;

/** One deduped lead, as stored in the `overture_leads` table. */
export interface OvertureLead {
	overture_id: string;
	name: string | null;
	brand_name: string | null;
	brand_wikidata: string | null;
	category: string;
	/** Staging-class bucket (restaurant/fast_food/cafe/… — see ovBucket). */
	bucket: string;
	confidence: number;
	latitude: number;
	longitude: number;
	/** Freeform street line from Overture (NOT importable — see module header). */
	street: string | null;
	/** Overture locality. */
	city: string | null;
	/** Overture address region (usually the 2-letter province code). */
	region: string | null;
	postcode: string | null;
	/** Resolved Canadian province code (point-in-polygon, or CA-coded address fallback). */
	province: string;
	website: string | null;
	phone: string | null;
	/** First non-Overture source dataset (e.g. "meta", "msft"), else "Overture". */
	primary_dataset: string;
	/** How many raw Overture rows this lead represents (1 = no near-duplicates). */
	dup_count: number;
	/** Overture release the pool was built from. */
	release: string;
}

/** Projects one NDJSON row (already province-resolved) onto the lead shape. */
export function leadFromRow(
	row: OvertureEateryRow,
	province: string,
	release: string
): OvertureLead {
	return {
		overture_id: row.id,
		name: row.name,
		brand_name: row.brand_name,
		brand_wikidata: row.brand_wikidata,
		category: row.category,
		bucket: ovBucket(row.category, row.hierarchy),
		confidence: row.confidence ?? 0,
		latitude: row.lat,
		longitude: row.lon,
		street: row.freeform,
		city: row.locality,
		region: row.addr_region,
		postcode: row.postcode,
		province,
		website: row.website,
		phone: row.phone,
		primary_dataset: primaryDataset(row.datasets),
		dup_count: 1,
		release
	};
}

/**
 * The normalized name a lead matches/dedups under: its own name, else its brand
 * name (some conflated rows carry only the brand). Empty = unmatchable — such a
 * lead never collapses into (or absorbs) anything.
 */
export function leadNormalizedName(lead: Pick<OvertureLead, 'name' | 'brand_name'>): string {
	return normalizeName(lead.name) || normalizeName(lead.brand_name);
}

/** A point with a pre-normalized name, as the OSM matcher probes them. */
export interface NamedPoint {
	normalized_name: string;
	latitude: number;
	longitude: number;
}

/**
 * Indexes the staging POIs once and returns a probe: "is there a name-related
 * POI within `radiusM` of this point?" — the experiment's match rule
 * (nameRelated is match-overture's proximity-anchored containment test).
 * An empty normalized name never matches, mirroring compare-osm-eateries.ts.
 */
export function buildOsmNameMatcher(
	pois: NamedPoint[],
	radiusM: number = OSM_MATCH_RADIUS_M
): (normalizedName: string, latitude: number, longitude: number) => boolean {
	const grid = new SpatialGrid(CELL_DEG);
	pois.forEach((p, i) => grid.insert(i, p.latitude, p.longitude));
	return (normalizedName, latitude, longitude) => {
		if (!normalizedName) return false;
		const box = bboxAround(latitude, longitude, radiusM / 1000);
		for (const idx of grid.candidatesInBbox(box)) {
			const poi = pois[idx];
			if (!nameRelated(poi.normalized_name, normalizedName)) continue;
			if (haversineMeters(poi.latitude, poi.longitude, latitude, longitude) <= radiusM) return true;
		}
		return false;
	};
}

/**
 * Collapses near-duplicate leads: name-related rows within `radiusM` merge into
 * their highest-confidence representative (greedy, confidence-descending, so a
 * representative is fixed before anything can collapse into it; ties break on
 * overture_id for determinism). Each absorbed row adds its dup_count to the
 * representative's. Input objects are not mutated; representatives are copies.
 */
export function dedupLeads(
	leads: OvertureLead[],
	radiusM: number = LEAD_DEDUP_RADIUS_M
): OvertureLead[] {
	const sorted = leads.toSorted(
		(a, b) => b.confidence - a.confidence || a.overture_id.localeCompare(b.overture_id)
	);
	const kept: OvertureLead[] = [];
	const keptNames: string[] = [];
	const grid = new SpatialGrid(CELL_DEG);
	for (const lead of sorted) {
		const name = leadNormalizedName(lead);
		let rep: OvertureLead | null = null;
		let repDist = Infinity;
		if (name) {
			const box = bboxAround(lead.latitude, lead.longitude, radiusM / 1000);
			for (const idx of grid.candidatesInBbox(box)) {
				if (!nameRelated(keptNames[idx], name)) continue;
				const d = haversineMeters(
					kept[idx].latitude,
					kept[idx].longitude,
					lead.latitude,
					lead.longitude
				);
				if (d <= radiusM && d < repDist) {
					repDist = d;
					rep = kept[idx];
				}
			}
		}
		if (rep) {
			rep.dup_count += lead.dup_count;
			continue;
		}
		grid.insert(kept.length, lead.latitude, lead.longitude);
		kept.push({ ...lead });
		keptNames.push(name);
	}
	return kept;
}
