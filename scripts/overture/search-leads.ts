// ---------------------------------------------------------------------------
// search_overture_leads: query the Overture leads pool (built by build-leads.ts
// into the staging store) for coverage-gap candidates, and — like search_poi —
// drop at query time any lead already covered by a name-related D1 record
// within 500 m. That includes CLOSED tombstones on purpose: per CLAUDE.md a
// closed record blocks re-suggestion forever, and a venue may have been
// imported (or recorded closed) after the leads table was built.
//
// A lead is a RESEARCH CANDIDATE only: verify the venue, find/add its OSM node,
// then import via osm_id (search_poi/create_locations or import_chain). Lead
// coordinates are NEVER written to the map (CLAUDE.md coordinate policy) —
// which is why candidates carry `approx_latitude`/`approx_longitude`, never
// fields a create_locations spread would accept.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { bboxAround, haversineMeters, SpatialGrid, type Bounds } from '../osm/geo';
import { existingInBbox, type ExistingLocation } from '../osm/search-poi';
import { leadNameTokens, nameTokens, tokensRelated, type OvertureLead } from './leads';
import { LEADS_SCAN_CAP, type OvertureLeadsStore } from './leads-store';

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
	/** Drop leads already covered by a D1 record — open OR closed (default true). */
	exclude_existing?: boolean;
	limit?: number;
	offset?: number;
	/** Override the store scan cap (testing only). */
	scanCap?: number;
}

/**
 * One lead returned to the caller. Its position is deliberately renamed to
 * `approx_latitude`/`approx_longitude`: a lead is field-for-field close to a
 * create_locations row (name/street/city/region/postcode/phone/website), so a
 * naive `{...lead}` spread must never validate as one — without `latitude`/
 * `longitude` (and without an `osm_id`) create_locations rejects it. The
 * "approx" is also literal: Overture positions are conflated from commercial
 * feeds and are NOT the OSM-exact coordinates locations require.
 */
export interface LeadCandidate extends Omit<OvertureLead, 'latitude' | 'longitude'> {
	approx_latitude: number;
	approx_longitude: number;
	/** Distance from the query centre in metres (only for centre+radius queries). */
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
	/**
	 * Leads dropped as covered by an existing D1 record — open or closed (0 when
	 * exclude_existing is false).
	 */
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
 * A lead within this distance of a name-related D1 record (open or closed)
 * counts as covered — the same radius the builder uses against staging POIs,
 * sized for the offset between Overture's conflated coordinates and our
 * OSM-verbatim ones.
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
 * True when a D1 record name-related to the lead sits within
 * {@link LEAD_COVER_RADIUS_M} — the venue the lead points at is already
 * recorded, OPEN OR CLOSED (a closed tombstone deliberately keeps blocking
 * re-suggestion, per CLAUDE.md). Uses the strict {@link tokensRelated}
 * relation, like the build gate and dedup. `grid`/`locationTokens` index
 * `existing` (see {@link searchOvertureLeads}). A lead with no usable name can
 * never be proven covered and is kept.
 */
export function isLeadCovered(
	lead: OvertureLead,
	existing: ExistingLocation[],
	grid: SpatialGrid,
	locationTokens: string[][]
): boolean {
	const leadTokens = leadNameTokens(lead);
	if (leadTokens.length === 0) return false;
	const box = bboxAround(lead.latitude, lead.longitude, LEAD_COVER_RADIUS_M / 1000);
	for (const idx of grid.candidatesInBbox(box)) {
		if (!tokensRelated(locationTokens[idx], leadTokens)) continue;
		const loc = existing[idx];
		const d = haversineMeters(loc.latitude, loc.longitude, lead.latitude, lead.longitude);
		if (d <= LEAD_COVER_RADIUS_M) return true;
	}
	return false;
}

/** Projects a lead onto the wire shape — position renamed (see {@link LeadCandidate}). */
function toCandidate(lead: OvertureLead, distance_m?: number): LeadCandidate {
	const { latitude, longitude, ...rest } = lead;
	return {
		...rest,
		approx_latitude: latitude,
		approx_longitude: longitude,
		...(distance_m === undefined ? {} : { distance_m: Math.round(distance_m) })
	};
}

/**
 * Queries the leads pool: area/name/city/province filters and the confidence
 * junk guard push into SQL; centre queries refine to the exact circle
 * (nearest-first); leads covered by an existing D1 record (open or closed) are
 * dropped; the survivor list pages via limit/offset like list_locations.
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
	// Over-fetch one row as the truncation probe: an area holding EXACTLY scanCap
	// rows must not read as truncated. Captured before exclusion shrinks the rows
	// — truncation is a property of the raw scan (mirrors search_poi).
	let rows = store.searchBbox(bbox, {
		name: params.name,
		city: params.city,
		province: params.province,
		brandedMinConfidence: branded,
		independentMinConfidence: independent,
		brandsOnly: params.brands_only,
		cap: scanCap + 1
	});
	const scanTruncated = rows.length > scanCap;
	if (scanTruncated) rows = rows.slice(0, scanCap);

	// Refine centre queries to the exact circle and re-order nearest-first
	// (bbox / filter-only queries keep the store's best-first order).
	let survivors: { lead: OvertureLead; distance_m?: number }[];
	if (centre) {
		const radiusM = centre.radiusKm * 1000;
		survivors = rows
			.map((lead) => ({
				lead,
				distance_m: haversineMeters(centre.lat, centre.lon, lead.latitude, lead.longitude)
			}))
			.filter((x) => x.distance_m <= radiusM)
			.toSorted((a, b) => a.distance_m - b.distance_m);
	} else {
		survivors = rows.map((lead) => ({ lead }));
	}

	let excluded = 0;
	if (excludeExisting && survivors.length > 0) {
		if (!db) throw new Error('exclude_existing requires a database handle.');
		// Fetch existing records over the leads' own extent (an area-less query has
		// no bbox of its own), padded so a venue just outside can still cover a lead.
		const fetchBox = (bbox === WORLD ? boundsOfLeads(rows) : null) ?? bbox;
		const existing = await existingInBbox(db, padBounds(fetchBox, LEAD_COVER_RADIUS_M));
		const grid = new SpatialGrid(COVER_CELL_DEG);
		existing.forEach((loc, i) => grid.insert(i, loc.latitude, loc.longitude));
		const locationTokens = existing.map((loc) => nameTokens(loc.name));
		const kept: typeof survivors = [];
		for (const x of survivors) {
			if (isLeadCovered(x.lead, existing, grid, locationTokens)) excluded++;
			else kept.push(x);
		}
		survivors = kept;
	}

	const page = survivors.slice(offset, offset + limit);
	return {
		leads: page.map((x) => toCandidate(x.lead, x.distance_m)),
		returned: page.length,
		has_more: offset + limit < survivors.length,
		limit,
		offset,
		total_matching: survivors.length,
		excluded_existing: excluded,
		scan_truncated: scanTruncated
	};
}
