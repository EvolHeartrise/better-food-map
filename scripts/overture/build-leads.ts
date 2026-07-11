// ---------------------------------------------------------------------------
// Builds the Overture leads pool into the OSM staging store (see leads.ts for
// what a lead is): reads data/overture-canada-eateries.ndjson (fetched by
// fetch-canada-eateries.py) + the osm_poi table of data/osm-poi.sqlite, keeps
// Canadian rows at confidence >= 0.85 with no name-related staging POI within
// 500 m, collapses near-duplicates, and drop-and-recreates the `overture_leads`
// table in the SAME SQLite file — queried by the search_overture_leads MCP tool
// (restart the MCP server after a rebuild).
//
// Run: bun scripts/overture/build-leads.ts
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import {
	OVERTURE_RELEASE,
	resolveProvince,
	streamNdjson,
	type OvertureEateryRow
} from './eateries';
import {
	buildOsmNameMatcher,
	dedupLeads,
	LEAD_MIN_CONFIDENCE,
	leadFromRow,
	leadNameTokens,
	type NamedPoint,
	type OvertureLead
} from './leads';
import { OvertureLeadsStore } from './leads-store';

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = process.env.OSM_POI_DB ?? `${ROOT}/data/osm-poi.sqlite`;
const NDJSON = `${ROOT}/data/overture-canada-eateries.ndjson`;

// ---- index the staging POIs (read-only pass; the store reopens writable below) ----
const poiDb = new Database(DB_PATH, { readonly: true });
const points = poiDb.query('SELECT name, latitude, longitude FROM osm_poi').all() as NamedPoint[];
poiDb.close();
const hasOsmMatch = buildOsmNameMatcher(points);
console.log(`indexed ${points.length} staging POIs from ${DB_PATH}`);

// ---- stream + filter the Overture rows ----
const raw: OvertureLead[] = [];
let total = 0;
let nonCanada = 0;
let lowConfidence = 0;
let closed = 0;
let matched = 0;
for await (const row of streamNdjson<OvertureEateryRow>(NDJSON)) {
	total++;
	const resolved = resolveProvince(row);
	if (!resolved) {
		nonCanada++;
		continue;
	}
	if ((row.confidence ?? 0) < LEAD_MIN_CONFIDENCE) {
		lowConfidence++;
		continue;
	}
	// A lead exists to be researched and imported; a venue Overture already knows
	// is permanently closed can never be either (CLAUDE.md closed-venue policy).
	if (row.operating_status === 'permanently_closed') {
		closed++;
		continue;
	}
	// Gate on the SAME tokens dedup/suppression use (leadNameTokens: name, else
	// brand_name) — gating on the raw name alone would let a brand-only row
	// (name: null, brand_name: "Yu Seafood") sail past its own staging POI.
	const lead = leadFromRow(row, resolved.code, OVERTURE_RELEASE);
	if (hasOsmMatch(leadNameTokens(lead), row.lat, row.lon)) {
		matched++;
		continue;
	}
	raw.push(lead);
}
console.log(
	`kept ${raw.length} pre-dedup leads of ${total} rows ` +
		`(${nonCanada} non-Canada, ${lowConfidence} low-confidence, ${closed} closed, ${matched} OSM-matched)`
);

// ---- collapse near-duplicates and rebuild the table ----
const leads = dedupLeads(raw);
const store = OvertureLeadsStore.open(DB_PATH);
const inserted = store.rebuild(leads);
store.close();
console.log(
	`wrote ${inserted} deduped leads to overture_leads in ${DB_PATH} ` +
		`(${raw.length - inserted} rows collapsed; release ${OVERTURE_RELEASE})`
);

const byBrand = new Map<string, number>();
for (const lead of leads) {
	const key = (lead.brand_name ?? lead.name ?? '??').trim();
	byBrand.set(key, (byBrand.get(key) ?? 0) + 1);
}
console.log('top 10 names:');
for (const [name, n] of [...byBrand.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 10)) {
	console.log(`  ${String(n).padStart(5)}  ${name}`);
}
