// ---------------------------------------------------------------------------
// find_identity_drift: audit existing locations against what the OSM staging
// store holds AT their exact coordinates.
//
// Complements find_coordinate_drift, which anchors on the NAME ("where did the
// POI with my name go?"). This audit anchors on the POSITION ("what does OSM
// now call the venue at my coordinates?"). Coordinates are OSM-verbatim (see
// CLAUDE.md), so the POI at ~0 m from a location IS its source node — and when
// that node's name no longer matches, OSM mappers have re-tagged it to a new
// occupant: the strongest offline signal that the venue was replaced or moved
// (e.g. Veerji Fish 'n' Grill's node became "Delight Street Eats" after the
// restaurant relocated). A node that is gone entirely ("vanished") was deleted,
// moved away, or dropped by the extract as lifecycle-tagged closed.
//
// The verdict is only as fresh as the staging store — rebuild it first
// (bun run osm:extract) or the audit is diffing against the past.
//
// Like the sibling audits, the only non-deterministic input is the single D1
// read; the matching itself is offline against the staging store.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { bboxAround, haversineMeters } from './geo';
import { osmUrl } from './map-feature';
import type { OsmPoiStore, StoredPoi } from './poi-store';
import { LOCATION_AUDIT, nearestNameMatch } from './poi-match';
import { normalizeName, namesMatch } from './search-poi';

export interface FindIdentityDriftParams {
	/** Max flagged locations to return (default 50, max 200). */
	limit?: number;
	/** A POI counts as sitting AT the location within this many metres (default 1 — coordinate-exact). */
	tolerance_m?: number;
	/**
	 * When a location is flagged, how far to look for a name-matching POI as a
	 * relocation lead (default 250, max 50000) — the venue may have moved to a
	 * nearby unit and kept (or re-acquired) an OSM node there.
	 */
	search_radius_m?: number;
	/** Also report locations whose POI is gone entirely (default true). */
	include_vanished?: boolean;
}

/** A name-matching POI elsewhere nearby — a lead that the venue moved rather than closed. */
export interface RelocationLead {
	osm_url: string;
	name: string | null;
	latitude: number;
	longitude: number;
	distance_m: number;
}

export interface IdentityDriftLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	/**
	 * 'renamed' = a POI still sits at the stored coordinates but its name no
	 * longer matches (node re-tagged to a new occupant); 'vanished' = no POI at
	 * the stored coordinates at all (node deleted, moved, or extract-dropped as
	 * closed-tagged).
	 */
	classification: 'renamed' | 'vanished';
	/** What OSM now calls the POI at the stored coordinates (renamed only). */
	current_osm_name?: string | null;
	osm_url?: string;
	osm_distance_m?: number;
	relocation_lead?: RelocationLead;
}

export interface FindIdentityDriftResult {
	flagged: IdentityDriftLocation[];
	/** Total DB locations scanned. */
	scanned: number;
	/** Total flags in scope (renamed, plus vanished when include_vanished). */
	total_flagged: number;
	/** How many of those are in `flagged`. */
	returned: number;
	/** Flags NOT returned because of `limit` (total_flagged - returned). */
	additional: number;
	/** Full breakdown of what was found, regardless of include_vanished. */
	counts: { renamed: number; vanished: number };
}

const { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M } = LOCATION_AUDIT;
const DEFAULT_TOLERANCE_M = 1;

interface LocationRow {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
}

async function allLocations(db: D1Like): Promise<LocationRow[]> {
	const { results } = await db
		.prepare('SELECT id, name, latitude, longitude FROM locations WHERE closed_at IS NULL')
		.all<LocationRow>();
	return results;
}

/** The nearest staging POI within `toleranceM` of the point, or null. */
function nearestAt(
	store: OsmPoiStore,
	lat: number,
	lon: number,
	toleranceM: number
): { poi: StoredPoi; dist: number } | null {
	// The box is tiny (tolerance is ~1 m), so the scan cap is never a concern.
	const bbox = bboxAround(lat, lon, Math.max(toleranceM, 1) / 1000);
	let best: { poi: StoredPoi; dist: number } | null = null;
	for (const poi of store.searchBbox(bbox, {
		cap: LOCATION_AUDIT.PER_LOCATION_CANDIDATE_CAP
	})) {
		const dist = haversineMeters(lat, lon, poi.latitude, poi.longitude);
		if (dist > toleranceM) continue;
		if (!best || dist < best.dist) best = { poi, dist };
	}
	return best;
}

/**
 * Scans every open location and inspects the staging POI at its exact stored
 * coordinates. Healthy = a POI within `tolerance_m` whose name matches (same
 * normalisation/containment rule as search_poi's dedup). Otherwise the location
 * is flagged 'renamed' (a non-matching POI occupies its coordinates) or
 * 'vanished' (no POI there at all), each with a `relocation_lead` when a
 * name-matching POI exists within `search_radius_m`.
 *
 * Renamed entries lead (a re-tagged node is the most actionable signal), then
 * vanished; `additional` reports how many more were found beyond `limit`.
 */
export async function findIdentityDrift(
	store: OsmPoiStore,
	db: D1Like,
	params: FindIdentityDriftParams
): Promise<FindIdentityDriftResult> {
	const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	const tolerance = Math.max(0, params.tolerance_m ?? DEFAULT_TOLERANCE_M);
	const searchRadiusKm =
		Math.min(Math.max(0, params.search_radius_m ?? DEFAULT_SEARCH_RADIUS_M), MAX_SEARCH_RADIUS_M) /
		1000;
	const includeVanished = params.include_vanished ?? true;

	const locations = await allLocations(db);
	const renamed: IdentityDriftLocation[] = [];
	const vanished: IdentityDriftLocation[] = [];

	for (const loc of locations) {
		const occupant = nearestAt(store, loc.latitude, loc.longitude, tolerance);
		if (
			occupant?.poi.name &&
			namesMatch(normalizeName(loc.name), normalizeName(occupant.poi.name))
		) {
			continue; // the node at our coordinates still carries our name — healthy
		}

		// A name-matching POI elsewhere nearby is a lead that the venue moved
		// (or that its node was re-created) rather than closed. Any match here is
		// beyond `tolerance` — a within-tolerance match would have been healthy.
		const lead = nearestNameMatch(store, loc, searchRadiusKm);
		const relocation_lead: RelocationLead | undefined = lead
			? {
					osm_url: osmUrl(lead.poi.osm_type, lead.poi.numeric_id),
					name: lead.poi.name,
					latitude: lead.poi.latitude,
					longitude: lead.poi.longitude,
					distance_m: Math.round(lead.dist)
				}
			: undefined;

		if (occupant) {
			// A nameless food POI at our coordinates can't be confirmed as us, so it
			// is still a rename signal (current_osm_name: null) — worth a look either way.
			renamed.push({
				id: loc.id,
				name: loc.name,
				latitude: loc.latitude,
				longitude: loc.longitude,
				classification: 'renamed',
				current_osm_name: occupant.poi.name,
				osm_url: osmUrl(occupant.poi.osm_type, occupant.poi.numeric_id),
				osm_distance_m: Math.round(occupant.dist),
				...(relocation_lead ? { relocation_lead } : {})
			});
		} else {
			vanished.push({
				id: loc.id,
				name: loc.name,
				latitude: loc.latitude,
				longitude: loc.longitude,
				classification: 'vanished',
				...(relocation_lead ? { relocation_lead } : {})
			});
		}
	}

	const ordered = includeVanished ? [...renamed, ...vanished] : renamed;
	const total = ordered.length;
	const flagged = ordered.slice(0, limit);
	return {
		flagged,
		scanned: locations.length,
		total_flagged: total,
		returned: flagged.length,
		additional: total - flagged.length,
		counts: { renamed: renamed.length, vanished: vanished.length }
	};
}
