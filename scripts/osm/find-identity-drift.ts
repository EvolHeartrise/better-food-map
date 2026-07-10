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
import { stripDiacritics } from '../../src/lib/text';
import { DismissFilter, fnv1a, type DismissableFinding, type DismissalOpts } from './audit-dismiss';
import { bboxAround, haversineMeters } from './geo';
import { osmUrl } from './map-feature';
import type { OsmPoiStore, StoredPoi } from './poi-store';
import { LOCATION_AUDIT, nearestNameMatch } from './poi-match';
import { normalizeName, namesMatch } from './search-poi';

export interface FindIdentityDriftParams extends DismissalOpts {
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

export interface IdentityDriftLocation extends DismissableFinding {
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

/** One rename folded as cosmetic — surfaced so the heuristic's calls stay auditable. */
export interface CosmeticRename {
	id: string;
	name: string;
	current_osm_name: string;
	osm_url: string;
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
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
	/**
	 * Renames folded as cosmetic (capped at `limit`; the full count is in
	 * `counts.cosmetic_renames`) — review these, since a wrong fold hides a real
	 * occupant change with no dismissal to revoke.
	 */
	cosmetic_renames: CosmeticRename[];
	/**
	 * Full breakdown of what was found, regardless of include_vanished.
	 * `cosmetic_renames` counts nodes whose new name is only a spelling/word-order
	 * variant of ours (see namesMatchCosmetic) — treated as still-our-venue, never flagged.
	 */
	counts: { renamed: number; vanished: number; cosmetic_renames: number };
}

/**
 * True when two RAW venue names differ only cosmetically — the same venue
 * respelled, not a new occupant. Catches what the dedup-grade namesMatch
 * (equality/containment on collapsed names) deliberately does not:
 *   • word order + diacritics/punctuation: "Bel Café" ↔ "Cafe Bel";
 *   • a tiny respelling: "Caffè Artigiano" ↔ "Cafe Artigiano" (edit distance 1).
 * Used ONLY by this audit's healthy test, where the compared POI sits at the
 * location's own coordinates and therefore IS its source node — at that anchor,
 * a 1–2 letter "different venue" is vanishingly unlikely versus a mapper
 * spelling fix. Never use it for dedup or name-anchored searching: across a
 * radius it would conflate genuinely distinct venues.
 *
 * Residual risk, accepted and kept auditable via the result's `cosmetic_renames`
 * list: a pure-letter distance-1 rename that IS a new occupant ("Mario's Pizza"
 * → "Maria's Pizza") folds wrongly. Digit changes never fold — "Pho 99" → "Pho
 * 88" is a renumbering, the classic ownership-change tell, so any edit budget
 * requires the two names' digits to agree exactly.
 */
export function namesMatchCosmetic(a: string, b: string): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	if (!na || !nb) return false;
	if (namesMatch(na, nb)) return true;
	if (setsEqual(tokenSet(a), tokenSet(b))) return true;
	// Tiny respellings only, and only on names long enough that the edit budget
	// is a small fraction of the name — and never across a digit change.
	if (digitsOf(na) !== digitsOf(nb)) return false;
	const shorter = Math.min(na.length, nb.length);
	if (shorter < 8) return false;
	const budget = shorter >= 14 ? 2 : 1;
	return levenshtein(na, nb) <= budget;
}

/** The name's digit subsequence ("pho99vietnamese" → "99"). */
function digitsOf(normalized: string): string {
	return normalized.replace(/[^0-9]/g, '');
}

/** The name's word tokens, individually folded like normalizeName. */
function tokenSet(name: string): Set<string> {
	return new Set(
		stripDiacritics(name)
			.toLowerCase()
			.replace(/&/g, ' and ')
			.split(/[^a-z0-9]+/)
			.filter((t) => t !== '')
	);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size === 0 || a.size !== b.size) return false;
	for (const t of a) if (!b.has(t)) return false;
	return true;
}

/** Plain two-row Levenshtein — names are short, so O(len²) is nothing. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
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
	const cosmetic: CosmeticRename[] = [];
	const filter = new DismissFilter(params);

	for (const loc of locations) {
		const occupant = nearestAt(store, loc.latitude, loc.longitude, tolerance);
		if (
			occupant?.poi.name &&
			namesMatch(normalizeName(loc.name), normalizeName(occupant.poi.name))
		) {
			continue; // the node at our coordinates still carries our name — healthy
		}
		if (occupant?.poi.name && namesMatchCosmetic(loc.name, occupant.poi.name)) {
			// Respelled, not replaced — still our venue; listed for review, not flagged.
			cosmetic.push({
				id: loc.id,
				name: loc.name,
				current_osm_name: occupant.poi.name,
				osm_url: osmUrl(occupant.poi.osm_type, occupant.poi.numeric_id)
			});
			continue;
		}
		// The occupant name pins the evidence. A nameless node and a name that
		// normalizes to nothing (CJK-only, emoji) are different evidence, so the
		// latter falls back to a content hash rather than colliding on "renamed:".
		const fingerprint = occupant
			? occupant.poi.name
				? `renamed:${normalizeName(occupant.poi.name) || fnv1a(occupant.poi.name)}`
				: 'renamed:unnamed'
			: 'vanished';
		const decision = filter.evaluate(loc.id, fingerprint);
		if (decision.drop) continue;

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
				...(relocation_lead ? { relocation_lead } : {}),
				...decision.fields
			});
		} else {
			vanished.push({
				id: loc.id,
				name: loc.name,
				latitude: loc.latitude,
				longitude: loc.longitude,
				classification: 'vanished',
				...(relocation_lead ? { relocation_lead } : {}),
				...decision.fields
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
		suppressed_dismissed: filter.suppressed,
		cosmetic_renames: cosmetic.slice(0, limit),
		counts: {
			renamed: renamed.length,
			vanished: vanished.length,
			cosmetic_renames: cosmetic.length
		}
	};
}
