// ---------------------------------------------------------------------------
// Pure build logic for the Overture leads pool (runner: build-leads.ts).
//
// A LEAD is a Canadian Overture eatery (confidence >= 0.85) with NO name-related
// OSM staging POI within 500 m — the 2026-07-10 comparison experiment
// (compare-osm-eateries.ts) sized this coverage gap at ~45k rows, heavily chain
// units OSM rarely maps. The raw pool carries internal duplication (Overture
// conflates the same venue from several source datasets): near-duplicate leads
// (name-related within ~150 m, street lines not disagreeing) are collapsed to
// their highest-confidence representative, with `dup_count` recording how many
// rows collapsed.
//
// A lead is a RESEARCH CANDIDATE only — its Overture coordinates/address are
// never imported (CLAUDE.md: location coordinates must be OSM-based).
// ---------------------------------------------------------------------------

import { stripDiacritics } from '../../src/lib/text';
import { bboxAround, haversineMeters, SpatialGrid } from '../osm/geo';
import { normalizeName } from '../osm/search-poi';
import { ovBucket, primaryDataset, type OvertureEateryRow } from './eateries';

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

// A contained name must join to at least this many characters (as in the other
// name-match rules: too-short fragments prove nothing).
const MIN_NAME_TOKEN_CHARS = 3;

/**
 * Tokenizes a venue name for the STRICT leads name relation: diacritics/case
 * folded, apostrophes removed (so "McDonald's" tokenizes like "McDonalds"),
 * "&" folded to "and", split on the remaining non-alphanumerics.
 */
export function nameTokens(name: string | null | undefined): string[] {
	if (!name) return [];
	return stripDiacritics(name)
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/&/g, ' and ')
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * The STRICT name relation every leads site uses (build gate, dedup, query-time
 * suppression): two names are related when their token joins are equal (spacing
 * variants: "PizzaHut" ↔ "Pizza Hut") or one name's full token SET is contained
 * in the other's ("Earls" ↔ "Earls Kitchen + Bar", "KFC" ↔ "Taco Bell / KFC").
 *
 * Deliberately NOT match-overture's `nameRelated`: that boundary-less substring
 * rule is safe only for the address enricher's tight-proximity matching, and at
 * leads distances (150–500 m) it false-matches across word boundaries —
 * "A&W" → "aandw" is a substring of "pizzaandwings", and "amano" ("A Mano") of
 * "yamanokami" ("Yama-No-Kami"). Token containment keeps the word boundaries,
 * so neither pair relates here.
 */
export function tokensRelated(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const ja = a.join('');
	const jb = b.join('');
	if (ja === jb) return true;
	const contains = (long: string[], short: string[], shortJoined: string): boolean => {
		if (shortJoined.length < MIN_NAME_TOKEN_CHARS) return false;
		const longSet = new Set(long);
		return short.every((t) => longSet.has(t));
	};
	return contains(b, a, ja) || contains(a, b, jb);
}

/**
 * The tokens a lead matches/dedups under: its own name, else its brand name
 * (some conflated rows carry only the brand — e.g. `name: null, brand_name:
 * "Yu Seafood"`). EVERY leads site must key off this, the OSM build gate
 * included: gating on the raw name alone would wave brand-only rows past their
 * own staging POI. Empty = unmatchable — such a lead never collapses into (or
 * absorbs, or is suppressed by) anything.
 */
export function leadNameTokens(lead: Pick<OvertureLead, 'name' | 'brand_name'>): string[] {
	const own = nameTokens(lead.name);
	return own.length > 0 ? own : nameTokens(lead.brand_name);
}

/** A staging point as the OSM matcher probes them (raw name; tokenized once inside). */
export interface NamedPoint {
	name: string | null;
	latitude: number;
	longitude: number;
}

/**
 * Indexes the staging POIs once and returns a probe: "is there a name-related
 * POI within `radiusM` of this point?" — the build gate, using the strict
 * {@link tokensRelated} relation. A lead with no tokens never matches (it can
 * only be vetted by hand).
 */
export function buildOsmNameMatcher(
	pois: NamedPoint[],
	radiusM: number = OSM_MATCH_RADIUS_M
): (leadTokens: string[], latitude: number, longitude: number) => boolean {
	const grid = new SpatialGrid(CELL_DEG);
	pois.forEach((p, i) => grid.insert(i, p.latitude, p.longitude));
	const poiTokens = pois.map((p) => nameTokens(p.name));
	return (leadTokens, latitude, longitude) => {
		if (leadTokens.length === 0) return false;
		const box = bboxAround(latitude, longitude, radiusM / 1000);
		for (const idx of grid.candidatesInBbox(box)) {
			const poi = pois[idx];
			if (!tokensRelated(poiTokens[idx], leadTokens)) continue;
			if (haversineMeters(poi.latitude, poi.longitude, latitude, longitude) <= radiusM) return true;
		}
		return false;
	};
}

/**
 * True when two street lines could describe the same premises: either side
 * missing, or equal after normalizeName folding. Distinct normalized lines
 * (usually different house numbers) mean two real branches — e.g. the same-brand
 * pair "299 Bloor Street West" vs "100 Devonshire Place" 78 m apart.
 */
function streetsCompatible(a: string | null, b: string | null): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	return na === '' || nb === '' || na === nb;
}

/**
 * Collapses near-duplicate leads: name-related rows within `radiusM` whose
 * street lines don't disagree (see {@link streetsCompatible} — same-brand
 * NEIGHBOURS with different street numbers stay separate leads) merge into
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
	const keptTokens: string[][] = [];
	const grid = new SpatialGrid(CELL_DEG);
	for (const lead of sorted) {
		const tokens = leadNameTokens(lead);
		let rep: OvertureLead | null = null;
		let repDist = Infinity;
		if (tokens.length > 0) {
			const box = bboxAround(lead.latitude, lead.longitude, radiusM / 1000);
			for (const idx of grid.candidatesInBbox(box)) {
				if (!tokensRelated(keptTokens[idx], tokens)) continue;
				if (!streetsCompatible(kept[idx].street, lead.street)) continue;
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
		keptTokens.push(tokens);
	}
	return kept;
}
