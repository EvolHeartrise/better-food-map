// ---------------------------------------------------------------------------
// One-shot backfill: durable source identity (`osm_id`, migration 0028) for
// locations already on the map, from the OSM POI staging store.
//
//   bun scripts/backfill-osm-id.ts           # dry run (default): report only
//   bun scripts/backfill-osm-id.ts --apply   # write the stamps to D1
//   OSM_POI_DB=path/to/osm-poi.sqlite …      # staging store (default data/osm-poi.sqlite)
//
// Every imported location sits at the EXACT coordinates of its staging POI
// (the OSM-verbatim coordinate policy), so the join is coordinate-identity —
// no fuzzy matching, ever: this backfill records identity, it must not guess
// it. A location is stamped only when exactly ONE POI sits at its exact
// coordinates, that POI's name still matches, and no other row claims the same
// POI. Everything else is REPORTED, not patched:
//   • zero exact POIs — the node moved/vanished since the extract, a closed
//     tombstone whose POI was dropped, or a known staging gap (Caffè
//     Artigiano); resolvable only by a fresh extract or by hand. A sub-ULP
//     coordinate NEAR-MISS (a way-centroid re-derived ~1e-14° off the stored
//     double, name still matching) is split into its own bucket so it doesn't
//     read as a moved node — reported, not stamped.
//   • several POIs at one point — an OSM double-mapping; picking one would
//     bake a coin flip into the identity column.
//   • one POI claimed by several locations (or by a row already stamped with
//     it) — coordinate-exact dedup should make this impossible, so it is
//     reported loudly for investigation.
//   • a name-mismatched POI — identity drift (the node may be a NEW occupant),
//     vetted via the identity_drift audit rather than stamped blind.
//
// Closed (soft-deleted) rows are scanned too: a tombstone's source identity is
// exactly what keeps it blocking re-suggestion if its node ever moves.
// ---------------------------------------------------------------------------

import { createHttpD1 } from '../src/lib/server/d1-http';
import type { D1PreparedLike } from '../src/lib/server/db';
import { OsmPoiStore } from './osm/poi-store';
import { normalizeName, namesMatch } from './osm/search-poi';

const APPLY = process.argv.includes('--apply');
const OSM_DB = process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite';

/** UPDATE statements per db.batch call, mirroring backfill-opening-hours. */
const CHUNK = 100;

// The bbox around a location is only the index probe; the match itself requires
// exact coordinate equality (verbatim-imported doubles round-trip exactly).
const EPS = 1e-7;

// A POI inside this of a stored coordinate WITHOUT being bit-identical is a
// float NEAR-MISS, not a moved node: a way-centroid re-derived in a fresh
// extract can land 1 ULP (~1e-14° at these magnitudes) off the stored double.
// 1e-9° ≈ 0.1 mm — far below any real node move, comfortably inside the probe.
const NEAR_MISS_EPS = 1e-9;

/** The live-location projection the plan works from (one D1 read). */
export interface LiveLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	osm_id: string | null;
	closed_at: number | null;
}

/** What {@link planBackfill} decides — the stamps to apply plus every reported oddity. */
export interface BackfillPlan {
	assignments: { id: string; osm_id: string }[];
	alreadyHave: number;
	/** No coordinate-exact POI (moved node, dropped closed POI, staging gap). */
	noExactPoi: { id: string; name: string; closed: boolean }[];
	/**
	 * Name-matching POI(s) within NEAR_MISS_EPS but not bit-identical — way-
	 * centroid float re-derivation, almost certainly the same element. Reported
	 * for hand-stamping (or a stamping flag, if these grow), never stamped blind:
	 * the join's contract is EXACT equality.
	 */
	nearMisses: { id: string; name: string; osm_ids: string[] }[];
	/** Several POIs at the exact point — OSM double-mapping, not guessed between. */
	multiPoi: { id: string; name: string; osm_ids: string[] }[];
	/**
	 * One POI claimed by more than one location (including a row already stamped
	 * with it) — should be impossible under coordinate-exact dedup, so every
	 * claimant is withheld and reported loudly.
	 */
	poiConflicts: { osm_id: string; location_ids: string[] }[];
	/** Coordinate-exact POI whose name no longer matches — identity drift, not stamped. */
	nameMismatches: { id: string; name: string; poi_name: string | null; osm_id: string }[];
}

/** The staging-store surface the plan needs (OsmPoiStore satisfies it). */
export interface OsmIdStoreLike {
	searchBbox(bbox: {
		minLat: number;
		maxLat: number;
		minLng: number;
		maxLng: number;
	}): { osm_id: string; name: string | null; latitude: number; longitude: number }[];
}

/** Pure matching core: which unstamped locations get which POI's id. */
export function planBackfill(locations: LiveLocation[], store: OsmIdStoreLike): BackfillPlan {
	const plan: BackfillPlan = {
		assignments: [],
		alreadyHave: 0,
		noExactPoi: [],
		nearMisses: [],
		multiPoi: [],
		poiConflicts: [],
		nameMismatches: []
	};
	// Every claim on a POI — pre-existing stamps and this run's tentative
	// assignments — so a POI claimed twice surfaces as a conflict either way.
	const claimants = new Map<string, string[]>();
	const claim = (osmId: string, locationId: string): void => {
		const list = claimants.get(osmId);
		if (list) list.push(locationId);
		else claimants.set(osmId, [locationId]);
	};
	for (const loc of locations) {
		if (loc.osm_id !== null) {
			plan.alreadyHave++;
			claim(loc.osm_id, loc.id);
			continue;
		}
		const candidates = store.searchBbox({
			minLat: loc.latitude - EPS,
			maxLat: loc.latitude + EPS,
			minLng: loc.longitude - EPS,
			maxLng: loc.longitude + EPS
		});
		const exact = candidates.filter(
			(p) => p.latitude === loc.latitude && p.longitude === loc.longitude
		);
		if (exact.length === 0) {
			// Split off the sub-ULP float near-misses before calling anything "moved".
			const near = candidates.filter(
				(p) =>
					Math.abs(p.latitude - loc.latitude) < NEAR_MISS_EPS &&
					Math.abs(p.longitude - loc.longitude) < NEAR_MISS_EPS &&
					namesMatch(normalizeName(loc.name), normalizeName(p.name))
			);
			if (near.length > 0) {
				plan.nearMisses.push({ id: loc.id, name: loc.name, osm_ids: near.map((p) => p.osm_id) });
			} else {
				plan.noExactPoi.push({ id: loc.id, name: loc.name, closed: loc.closed_at !== null });
			}
			continue;
		}
		if (exact.length > 1) {
			plan.multiPoi.push({ id: loc.id, name: loc.name, osm_ids: exact.map((p) => p.osm_id) });
			continue;
		}
		const poi = exact[0];
		if (!namesMatch(normalizeName(loc.name), normalizeName(poi.name))) {
			plan.nameMismatches.push({
				id: loc.id,
				name: loc.name,
				poi_name: poi.name,
				osm_id: poi.osm_id
			});
			continue;
		}
		claim(poi.osm_id, loc.id);
		plan.assignments.push({ id: loc.id, osm_id: poi.osm_id });
	}
	// Withhold every multiply-claimed POI's assignments — identity must stay 1:1.
	const conflicted = new Set<string>();
	for (const [osmId, ids] of claimants) {
		if (ids.length > 1) {
			conflicted.add(osmId);
			plan.poiConflicts.push({ osm_id: osmId, location_ids: ids });
		}
	}
	if (conflicted.size) {
		plan.assignments = plan.assignments.filter((a) => !conflicted.has(a.osm_id));
	}
	return plan;
}

async function main(): Promise<void> {
	const db = createHttpD1();
	const store = OsmPoiStore.openReadonly(OSM_DB);

	// Closed rows included on purpose — see the header note on tombstones.
	const { results: locations } = await db
		.prepare(`SELECT id, name, latitude, longitude, osm_id, closed_at FROM locations`)
		.bind()
		.all<LiveLocation>();

	const {
		assignments,
		alreadyHave,
		noExactPoi,
		nearMisses,
		multiPoi,
		poiConflicts,
		nameMismatches
	} = planBackfill(locations, store);

	const closedNoPoi = noExactPoi.filter((l) => l.closed).length;
	console.error(`Locations scanned:             ${locations.length}`);
	console.error(`Already have osm_id:           ${alreadyHave}`);
	console.error(`No coordinate-exact POI:       ${noExactPoi.length} (${closedNoPoi} closed)`);
	console.error(`Sub-ULP near-miss (reported):  ${nearMisses.length}`);
	console.error(`Multiple POIs at point:        ${multiPoi.length}`);
	console.error(`POI claimed twice (WITHHELD):  ${poiConflicts.length}`);
	console.error(`Name mismatch (skipped):       ${nameMismatches.length}`);
	console.error(`To stamp:                      ${assignments.length}`);

	if (poiConflicts.length) {
		console.error(
			'\nPOI CONFLICTS — two locations at one POI should be impossible under coordinate-exact ' +
				'dedup; investigate each before any of these rows is stamped:'
		);
		for (const c of poiConflicts) {
			console.error(`  ${c.osm_id}  claimed by ${c.location_ids.join(', ')}`);
		}
	}
	if (multiPoi.length) {
		console.error('\nOSM double-mappings — several POIs at one point, none chosen:');
		for (const m of multiPoi) {
			console.error(`  ${m.id}  "${m.name}"  candidates: ${m.osm_ids.join(', ')}`);
		}
	}
	if (nearMisses.length) {
		console.error(
			'\nSub-ULP near-misses — a re-derived way centroid, same element by name; the exact-equality ' +
				'contract withholds the stamp, so apply these by hand after a spot check:'
		);
		for (const n of nearMisses) {
			console.error(`  ${n.id}  "${n.name}"  candidates: ${n.osm_ids.join(', ')}`);
		}
	}
	if (nameMismatches.length) {
		console.error('\nName mismatches — vet via the identity_drift audit, not stamped here:');
		for (const m of nameMismatches.slice(0, 20)) {
			console.error(`  ${m.id}  "${m.name}"  vs POI "${m.poi_name ?? '(unnamed)'}" (${m.osm_id})`);
		}
		if (nameMismatches.length > 20) console.error(`  … and ${nameMismatches.length - 20} more.`);
	}
	if (noExactPoi.length) {
		console.error('\nNo coordinate-exact POI — moved/dropped nodes and staging gaps:');
		for (const l of noExactPoi.slice(0, 30)) {
			console.error(`  ${l.id}  "${l.name}"${l.closed ? '  (closed)' : ''}`);
		}
		if (noExactPoi.length > 30) console.error(`  … and ${noExactPoi.length - 30} more.`);
	}

	if (!APPLY) {
		console.error('\nDry run — nothing written. Sample of pending stamps:');
		for (const a of assignments.slice(0, 10)) console.error(`  ${a.id}  ${a.osm_id}`);
		console.error('\nRe-run with --apply to write.');
		return;
	}

	// Direct UPDATEs, not updateLocations: osm_id is deliberately absent from
	// LocationPatch — identity is stamped by the import path and this backfill,
	// never patched through the MCP update surface. The IS NULL guard keeps a
	// re-run (or a concurrent import) from ever overwriting a stamp.
	let updated = 0;
	let attempted = 0;
	for (let i = 0; i < assignments.length; i += CHUNK) {
		const chunk = assignments.slice(i, i + CHUNK);
		const stmts: D1PreparedLike[] = chunk.map((a) =>
			db
				.prepare(`UPDATE locations SET osm_id = ? WHERE id = ? AND osm_id IS NULL`)
				.bind(a.osm_id, a.id)
		);
		// Count what the UPDATEs actually changed (the IS NULL guard can no-op a
		// row stamped since the plan was read), not what was attempted.
		const results = (await db.batch(stmts)) as { meta?: { changes?: number } }[];
		updated += results.reduce((n, r) => n + (r?.meta?.changes ?? 0), 0);
		attempted += chunk.length;
		console.error(`applied ${updated}/${assignments.length}`);
	}
	console.error(`\nDone: ${updated} locations stamped (${attempted - updated} no-op).`);
}

// Only run as a CLI — the matching core (planBackfill) is imported by tests.
if (import.meta.main) await main();
