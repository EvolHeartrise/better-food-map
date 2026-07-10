// ---------------------------------------------------------------------------
// One-shot backfill: opening hours for locations already on the map, from the
// OSM POI staging store (migration 0027).
//
//   bun scripts/backfill-opening-hours.ts           # dry run (default): report only
//   bun scripts/backfill-opening-hours.ts --apply   # write the patches to D1
//   OSM_POI_DB=path/to/osm-poi.sqlite …             # staging store (default data/osm-poi.sqlite)
//
// Every imported location sits at the EXACT coordinates of its staging POI
// (the OSM-verbatim coordinate policy), so the join is coordinate-identity —
// no fuzzy matching. A location is patched only when:
//   • it has no hours yet (never clobbers agent-set hours), and
//   • a staging POI sits at its exact coordinates with `opening_hours` tagged, and
//   • the POI's name still matches the location's (a mismatch is identity
//     drift — the POI may be a NEW occupant whose hours aren't this venue's —
//     so it is reported for the identity_drift audit instead of patched).
//
// Writes go through updateLocations, which derives `opening_hours_json` from
// the raw string (src/lib/opening-hours.ts), same as every other write path.
// Values beyond the parsed OSM subset are still stored (displayed verbatim)
// and counted as raw-only here.
// ---------------------------------------------------------------------------

import { createHttpD1 } from '../src/lib/server/d1-http';
import { updateLocations, type LocationPatch } from '../src/lib/server/db-write';
import { weeklyHoursJson } from '../src/lib/opening-hours';
import { OsmPoiStore } from './osm/poi-store';
import { normalizeName, namesMatch } from './osm/search-poi';

const APPLY = process.argv.includes('--apply');
const OSM_DB = process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite';

/** updateLocations batch size, mirroring the update_locations tool's 100 cap. */
const CHUNK = 100;

// The bbox around a location is only the index probe; the match itself requires
// exact coordinate equality (verbatim-imported doubles round-trip exactly).
const EPS = 1e-7;

/** The live-location projection the plan works from (one D1 read). */
export interface LiveLocation {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	opening_hours: string | null;
}

/** What {@link planBackfill} decides — the patches to apply plus the census. */
export interface BackfillPlan {
	patches: LocationPatch[];
	alreadyHave: number;
	noExactPoi: number;
	poiWithoutHours: number;
	/** Patched anyway, but the raw string is beyond the parsed OSM subset. */
	rawOnly: number;
	/** Coordinate-exact POI whose name no longer matches — identity drift, not patched. */
	nameMismatches: { id: string; name: string; poi_name: string | null }[];
}

/** The staging-store surface the plan needs (OsmPoiStore satisfies it). */
export interface HoursStoreLike {
	searchBbox(bbox: {
		minLat: number;
		maxLat: number;
		minLng: number;
		maxLng: number;
	}): { name: string | null; latitude: number; longitude: number; opening_hours: string | null }[];
}

/** Pure matching core: which hours-less locations get which POI's hours. */
export function planBackfill(locations: LiveLocation[], store: HoursStoreLike): BackfillPlan {
	const plan: BackfillPlan = {
		patches: [],
		alreadyHave: 0,
		noExactPoi: 0,
		poiWithoutHours: 0,
		rawOnly: 0,
		nameMismatches: []
	};
	for (const loc of locations) {
		if (loc.opening_hours !== null) {
			plan.alreadyHave++;
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
			plan.noExactPoi++;
			continue;
		}
		// Coordinate-exact dedup means at most one live venue per point; if OSM
		// carries two nodes here, prefer the one that has hours.
		const poi = exact.find((p) => p.opening_hours !== null) ?? exact[0];
		if (poi.opening_hours === null) {
			plan.poiWithoutHours++;
			continue;
		}
		if (!namesMatch(normalizeName(loc.name), normalizeName(poi.name))) {
			plan.nameMismatches.push({ id: loc.id, name: loc.name, poi_name: poi.name });
			continue;
		}
		if (weeklyHoursJson(poi.opening_hours) === null) plan.rawOnly++;
		plan.patches.push({ id: loc.id, opening_hours: poi.opening_hours });
	}
	return plan;
}

async function main(): Promise<void> {
	const db = createHttpD1();
	const store = OsmPoiStore.openReadonly(OSM_DB);

	const { results: locations } = await db
		.prepare(
			`SELECT id, name, latitude, longitude, opening_hours
			 FROM locations WHERE closed_at IS NULL`
		)
		.bind()
		.all<LiveLocation>();

	const { patches, alreadyHave, noExactPoi, poiWithoutHours, rawOnly, nameMismatches } =
		planBackfill(locations, store);

	console.error(`Live locations scanned:        ${locations.length}`);
	console.error(`Already have hours:            ${alreadyHave}`);
	console.error(`No coordinate-exact POI:       ${noExactPoi}`);
	console.error(`POI has no hours tagged:       ${poiWithoutHours}`);
	console.error(`Name mismatch (skipped):       ${nameMismatches.length}`);
	console.error(`To patch:                      ${patches.length} (${rawOnly} raw-only)`);

	if (nameMismatches.length) {
		console.error('\nName mismatches — vet via the identity_drift audit, not patched here:');
		for (const m of nameMismatches.slice(0, 20)) {
			console.error(`  ${m.id}  "${m.name}"  vs POI "${m.poi_name ?? '(unnamed)'}"`);
		}
		if (nameMismatches.length > 20) console.error(`  … and ${nameMismatches.length - 20} more.`);
	}

	if (!APPLY) {
		console.error('\nDry run — nothing written. Sample of pending patches:');
		for (const p of patches.slice(0, 10)) console.error(`  ${p.id}  ${p.opening_hours}`);
		console.error('\nRe-run with --apply to write.');
		return;
	}

	let updated = 0;
	for (let i = 0; i < patches.length; i += CHUNK) {
		const chunk = patches.slice(i, i + CHUNK);
		const res = await updateLocations(db, chunk);
		updated += res.updatedIds.length;
		console.error(`applied ${updated}/${patches.length}`);
	}
	console.error(`\nDone: ${updated} locations backfilled.`);
}

// Only run as a CLI — the matching core (planBackfill) is imported by tests.
if (import.meta.main) await main();
