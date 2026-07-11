// ---------------------------------------------------------------------------
// search_overture_leads: query the Overture leads pool (built by build-leads.ts
// into the staging store) for coverage-gap candidates, and — like search_poi —
// drop at query time any lead already covered by a live D1 venue, since a venue
// may have been imported after the leads table was built.
//
// A lead is a RESEARCH CANDIDATE only: verify the venue, find/add its OSM node,
// then import via osm_id (search_poi/create_locations or import_chain). Lead
// coordinates are NEVER written to the map (CLAUDE.md coordinate policy).
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { bboxAround, haversineMeters, SpatialGrid, type Bounds } from '../osm/geo';
import { existingInBbox, normalizeName, type ExistingLocation } from '../osm/search-poi';
import { leadNormalizedName, type OvertureLead } from './leads';
import { LEADS_SCAN_CAP, type OvertureLeadsStore } from './leads-store';
import { nameRelated } from './match-overture';

export interface SearchLeadsParams {
	/** Explicit bounding box. Provide this OR latitude+longitude+radius_km (or neither). */
	bbox?: Bounds;
	latitude?: number;
	longitude?: number;
	radius_km?: number;
	/** Case-insensitive substring match on the Overture locality. */
	city?: string;
	/** Resolved province code, e.g. "BC". */
	province?: string;
	/** Case-insensitive substring match on the lead name OR brand name. */
	name?: string;
	/**
	 * Confidence floor. When OMITTED, branded rows use 0.85 and independents 0.9
	 * (the junk guard — see {@link INDEPENDENT_MIN_CONFIDENCE}); when set, it
	 * applies to every row.
	 */
	min_confidence?: number;
	/** Only leads carrying a brand signal (brand_wikidata or brand_name). */
	brands_only?: boolean;
	/** Drop leads already covered by a live venue (default true). */
	exclude_existing?: boolean;
	limit?: number;
	offset?: number;
	/** Override the store scan cap (testing only). */
	scanCap?: number;
}

/** One lead returned to the caller (distance only for centre+radius queries). */
export interface LeadCandidate extends OvertureLead {
	distance_m?: number;
}

export interface SearchLeadsResult {
	leads: LeadCandidate[];
	/** How many rows this page carries (`leads.length`). */
	returned: number;
	/** True when more matching leads exist beyond this page. */
	has_more: boolean;
	limit: number;
	offset: number;
	/** Matching leads after exclusion, across all pages. */
	total_matching: number;
	/** Leads dropped as already covered by a live venue (0 when exclude_existing is false). */
	excluded_existing: number;
	/**
	 * Whether the store scan hit its row cap before filtering finished — the area
	 * holds more leads than were even considered; narrow the filters.
	 */
	scan_truncated: boolean;
}

/** Default confidence floor (the pool's own floor). */
export const DEFAULT_MIN_CONFIDENCE = 0.85;
/**
 * Default confidence floor for INDEPENDENTS (no brand signal): Overture's
 * miscategorized non-eateries concentrate in the unbranded 0.85–0.9 band (e.g.
 * ~2/3 of the "Wine Rack" wine-retail units sit there), so independents need
 * 0.9 unless the caller explicitly lowers the floor.
 */
export const INDEPENDENT_MIN_CONFIDENCE = 0.9;
/**
 * A lead within this distance of a name-related live venue counts as covered —
 * the same radius the builder uses against staging POIs, sized for the offset
 * between Overture's conflated coordinates and our OSM-verbatim ones.
 */
export const LEAD_COVER_RADIUS_M = 500;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Existing-venue grid cell ≈ 1.1 km, comfortably above the 500 m probe box.
const COVER_CELL_DEG = 0.01;

const WORLD: Bounds = { minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 };

/** Clamps a requested page size to [1, MAX] (default 50) — as list_locations does. */
function resolveLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

/**
 * Resolves the query area: an explicit bbox, a centre+radius (kept for the
 * exact-circle refine), or — unlike search_poi — NO area at all, meaning the
 * whole pool (city/province/name filters still apply).
 */
export function resolveLeadArea(params: SearchLeadsParams): {
	bbox: Bounds;
	centre?: { lat: number; lon: number; radiusKm: number };
} {
	if (params.bbox) return { bbox: params.bbox };
	const { latitude, longitude, radius_km } = params;
	if (latitude !== undefined && longitude !== undefined && radius_km !== undefined) {
		return {
			bbox: bboxAround(latitude, longitude, radius_km),
			centre: { lat: latitude, lon: longitude, radiusKm: radius_km }
		};
	}
	if (latitude !== undefined || longitude !== undefined || radius_km !== undefined) {
		throw new Error(
			'Provide `bbox`, or all of `latitude`, `longitude` and `radius_km`, or no area at all.'
		);
	}
	return { bbox: WORLD };
}

/** Pads `bbox` by `padM` metres on every side (clamped), for the coverage fetch. */
function padBounds(bbox: Bounds, padM: number): Bounds {
	const worstLat = Math.max(Math.abs(bbox.minLat), Math.abs(bbox.maxLat));
	const pad = bboxAround(worstLat, 0, padM / 1000);
	const padLat = pad.maxLat - worstLat;
	const padLon = pad.maxLng;
	return {
		minLat: Math.max(bbox.minLat - padLat, -90),
		maxLat: Math.min(bbox.maxLat + padLat, 90),
		minLng: Math.max(bbox.minLng - padLon, -180),
		maxLng: Math.min(bbox.maxLng + padLon, 180)
	};
}

/** The tightest bbox containing every lead (null when there are none). */
function boundsOfLeads(leads: OvertureLead[]): Bounds | null {
	if (leads.length === 0) return null;
	const box = {
		minLat: Infinity,
		maxLat: -Infinity,
		minLng: Infinity,
		maxLng: -Infinity
	};
	for (const lead of leads) {
		box.minLat = Math.min(box.minLat, lead.latitude);
		box.maxLat = Math.max(box.maxLat, lead.latitude);
		box.minLng = Math.min(box.minLng, lead.longitude);
		box.maxLng = Math.max(box.maxLng, lead.longitude);
	}
	return box;
}

/**
 * True when a live venue name-related to the lead sits within
 * {@link LEAD_COVER_RADIUS_M} — the venue the lead points at is (now) on the
 * map. `grid` indexes `existing` (see {@link searchOvertureLeads}). A lead with
 * no usable name can never be proven covered and is kept.
 */
export function isLeadCovered(
	lead: OvertureLead,
	existing: ExistingLocation[],
	grid: SpatialGrid,
	names: string[]
): boolean {
	const leadName = leadNormalizedName(lead);
	if (!leadName) return false;
	const box = bboxAround(lead.latitude, lead.longitude, LEAD_COVER_RADIUS_M / 1000);
	for (const idx of grid.candidatesInBbox(box)) {
		if (!nameRelated(names[idx], leadName)) continue;
		const loc = existing[idx];
		const d = haversineMeters(loc.latitude, loc.longitude, lead.latitude, lead.longitude);
		if (d <= LEAD_COVER_RADIUS_M) return true;
	}
	return false;
}

/**
 * Queries the leads pool: area/name/city/province filters and the confidence
 * junk guard push into SQL; centre queries refine to the exact circle
 * (nearest-first); live-venue coverage is dropped; the survivor list pages via
 * limit/offset like list_locations.
 *
 * `db` may be null only when `exclude_existing` is false (offline/testing).
 */
export async function searchOvertureLeads(
	store: OvertureLeadsStore,
	db: D1Like | null,
	params: SearchLeadsParams
): Promise<SearchLeadsResult> {
	const { bbox, centre } = resolveLeadArea(params);
	const excludeExisting = params.exclude_existing ?? true;
	const limit = resolveLimit(params.limit);
	const offset = Math.max(0, Math.trunc(params.offset ?? 0));

	// The junk guard: an explicit min_confidence applies to everything; omitted,
	// independents get the stricter default (see INDEPENDENT_MIN_CONFIDENCE).
	const branded = params.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
	const independent =
		params.min_confidence ?? Math.max(DEFAULT_MIN_CONFIDENCE, INDEPENDENT_MIN_CONFIDENCE);

	const scanCap = params.scanCap ?? LEADS_SCAN_CAP;
	const rows = store.searchBbox(bbox, {
		name: params.name,
		city: params.city,
		province: params.province,
		brandedMinConfidence: branded,
		independentMinConfidence: independent,
		brandsOnly: params.brands_only,
		cap: scanCap
	});
	// Captured before exclusion shrinks `rows` — truncation is a property of the
	// raw scan (mirrors search_poi).
	const scanTruncated = rows.length >= scanCap;

	// Refine centre queries to the exact circle and re-order nearest-first
	// (bbox / filter-only queries keep the store's best-first order).
	let withDistance: LeadCandidate[];
	if (centre) {
		const radiusM = centre.radiusKm * 1000;
		withDistance = rows
			.map((lead) => ({
				...lead,
				distance_m: haversineMeters(centre.lat, centre.lon, lead.latitude, lead.longitude)
			}))
			.filter((x) => x.distance_m <= radiusM)
			.toSorted((a, b) => a.distance_m - b.distance_m)
			.map((x) => ({ ...x, distance_m: Math.round(x.distance_m) }));
	} else {
		withDistance = rows;
	}

	let excluded = 0;
	if (excludeExisting && withDistance.length > 0) {
		if (!db) throw new Error('exclude_existing requires a database handle.');
		// Fetch live venues over the leads' own extent (an area-less query has no
		// bbox of its own), padded so a venue just outside can still cover a lead.
		const fetchBox = (bbox === WORLD ? boundsOfLeads(withDistance) : null) ?? bbox;
		const existing = await existingInBbox(db, padBounds(fetchBox, LEAD_COVER_RADIUS_M));
		const grid = new SpatialGrid(COVER_CELL_DEG);
		existing.forEach((loc, i) => grid.insert(i, loc.latitude, loc.longitude));
		const names = existing.map((loc) => normalizeName(loc.name));
		const kept: LeadCandidate[] = [];
		for (const lead of withDistance) {
			if (isLeadCovered(lead, existing, grid, names)) excluded++;
			else kept.push(lead);
		}
		withDistance = kept;
	}

	const page = withDistance.slice(offset, offset + limit);
	return {
		leads: page,
		returned: page.length,
		has_more: offset + limit < withDistance.length,
		limit,
		offset,
		total_matching: withDistance.length,
		excluded_existing: excluded,
		scan_truncated: scanTruncated
	};
}
