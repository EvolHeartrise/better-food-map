/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// overture:enrich — fill gaps in the local OSM POI staging store from local
// Overture Maps caches. Two independent passes:
//
//  ADDRESSES (--input, the original pass):
//   bun run overture:enrich --input overture-places.ndjson --release 2026-06-17.0
//
// Why: about half of OSM food POIs (and ~all of some chains, e.g. KFC) carry no
// usable address — not in their own tags, nor in any OSM building they sit in.
// Overture Places (CDLA-Permissive 2.0, free) covers them well. This matches each
// address-less staging POI to the nearest name-related Overture place within a
// small radius and fills ONLY its address, recording `overture:<id> (<release>)`
// as the provenance. Coordinates are left untouched — OSM stays the coordinate
// source so search_poi's coordinate-exact dedup keeps working (see CLAUDE.md).
//
//  CONTACTS + IDENTITY (--eateries, the eateries NDJSON built by
//  scripts/overture/fetch-canada-eateries.py):
//   bun run overture:enrich --eateries data/overture-canada-eateries.ndjson --release 2026-06-17.0
//
// Why: Overture carries website on ~83% and phone on ~91% of Canadian eateries
// vs ~26% each in the staging store (issue #302's comparison). This pass matches
// EVERY staging POI (same nearest-name-related semantics and radius as the
// address pass), banks the match on the row (overture_id + distance — the
// identity join later passes build on), and fills website / phone / cuisine
// gaps with per-field provenance (website_source / phone_source /
// cuisine_source, same "overture:<id> (<release>)" format as address_source).
// OSM-sourced values are never overwritten; overture-sourced ones are
// recomputed on every run — a LOST match (a previously banked POI nothing
// matched this run) has its overture_id and Overture-sourced fills cleared,
// so re-runs are idempotent and self-correcting (see
// scripts/overture/enrich-contacts.ts). A mass-clear guard aborts a real run
// that would clear >20% of previously banked rows (the tell of a
// partial/regional NDJSON) unless --allow-mass-clear is passed. A
// permanently_closed Overture place is banked as identity (signal for the
// closure-signals pass) but never donates fills. US-spillover NDJSON rows need
// no pre-filter: a match requires a name-related staging POI within the
// radius, which is anchor enough. Coordinates are, as always, untouched.
//
// After running this, find_missing_address surfaces the filled addresses (with
// `address_source` set) so existing locations can be backfilled, and search_poi
// candidates carry the filled addresses/contacts for new imports — all through
// the existing tooling.
//
// FETCHING THE CACHE (the `--input` file) is a separate, one-off step, done with
// DuckDB over Overture's public GeoParquet release (no account needed). Example —
// all KFC/Quiznos in/near Canada from release 2026-06-17.0 as NDJSON:
//
//   -- list the place file keys first (anonymous S3 listing is disabled):
//   --   curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2\
//   --     &prefix=release/2026-06-17.0/theme=places/type=place/" | grep -o '<Key>[^<]*</Key>'
//   INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
//   SET s3_region='us-west-2';
//   COPY (
//     SELECT id, names.primary AS name,
//            ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
//            addresses[1].freeform AS freeform, addresses[1].locality AS locality,
//            addresses[1].region AS region, addresses[1].postcode AS postcode
//     FROM read_parquet([<the s3:// keys above>])
//     WHERE bbox.xmin BETWEEN -141 AND -52 AND bbox.ymin BETWEEN 41 AND 84
//       AND addresses[1].freeform IS NOT NULL
//   ) TO 'overture-places.ndjson' (FORMAT json);
//
// Each line is {id, name, lon, lat, freeform, locality, region, postcode}. A
// top-level JSON array is also accepted.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { parseArgs as parseArgsUtil } from 'node:util';
import { OsmPoiStore } from './osm/poi-store';
import { streamNdjson } from './overture/eateries';
import {
	matchOverturePlaces,
	matchNearestPlaces,
	composeOvertureAddress,
	type OverturePlace
} from './overture/match-overture';
import {
	planOvertureBank,
	planOvertureClear,
	massClearExceeded,
	MASS_CLEAR_FRACTION,
	isOvertureSourced,
	type OvertureEatery
} from './overture/enrich-contacts';

interface Args {
	db: string;
	input?: string;
	eateries?: string;
	radiusM: number;
	release: string;
	dryRun: boolean;
	allowMassClear: boolean;
}

function parseArgs(argv: string[]): Args {
	let values;
	try {
		({ values } = parseArgsUtil({
			args: argv,
			options: {
				db: { type: 'string', default: 'data/osm-poi.sqlite' },
				input: { type: 'string' },
				eateries: { type: 'string' },
				'radius-m': { type: 'string', default: '100' },
				release: { type: 'string' },
				'dry-run': { type: 'boolean', default: false },
				'allow-mass-clear': { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false }
			},
			allowPositionals: false
		}));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const m = msg.match(/'([^']+)'/);
		console.error(`Unknown argument: ${m ? m[1] : msg}`);
		return printUsageAndExit(1);
	}
	if (values.help) printUsageAndExit(0);

	const args: Args = {
		db: values.db,
		input: values.input,
		eateries: values.eateries,
		radiusM: Number(values['radius-m']),
		release: values.release as string,
		dryRun: values['dry-run'],
		allowMassClear: values['allow-mass-clear']
	};
	if ((!args.input && !args.eateries) || !args.release) {
		console.error('Error: --release and at least one of --input / --eateries are required.\n');
		printUsageAndExit(1);
	}
	if (!Number.isFinite(args.radiusM) || (args.radiusM ?? 0) <= 0) {
		console.error('Error: --radius-m must be a positive number.\n');
		printUsageAndExit(1);
	}
	return args;
}

function printUsageAndExit(code: number): never {
	console.error(
		'Usage: bun run overture:enrich [--input <places.ndjson>] [--eateries <eateries.ndjson>] --release <id> [--db <path>] [--radius-m <m>] [--dry-run]\n' +
			'\n' +
			'  --input     Overture places cache for the ADDRESS pass (NDJSON or JSON array; see header).\n' +
			'  --eateries  Overture eateries NDJSON for the CONTACTS+IDENTITY pass (built by\n' +
			'              scripts/overture/fetch-canada-eateries.py). At least one of --input/--eateries.\n' +
			'  --release   Overture release id, recorded in each provenance citation (e.g. 2026-06-17.0).\n' +
			'  --db        Staging SQLite path (default: data/osm-poi.sqlite).\n' +
			'  --radius-m  Max distance for a POI↔place match (default 100, both passes).\n' +
			'  --dry-run   Report what would be filled without writing.\n' +
			'  --allow-mass-clear  Let the contacts pass clear more than ' +
			`${Math.round(MASS_CLEAR_FRACTION * 100)}% of previously banked\n` +
			'              matches (normally the tell of a partial/regional --eateries file; a real run aborts).\n'
	);
	process.exit(code);
}

/** One raw record from the Overture cache (DuckDB query output). */
interface RawPlace {
	id?: string;
	name?: string | null;
	lon?: number;
	lat?: number;
	freeform?: string | null;
	locality?: string | null;
	region?: string | null;
	postcode?: string | null;
}

/** Maps a raw cache record to an {@link OverturePlace}, or null if it can't be used. */
function toPlace(raw: RawPlace): OverturePlace | null {
	if (!raw.id || typeof raw.lon !== 'number' || typeof raw.lat !== 'number') return null;
	// A place with no street line cannot fill a missing address: composing its
	// locality-only remainder would later be re-parsed with the lone segment as
	// the STREET (addressPartsFromLine's rule), inventing streets like
	// "Curry County". Overture rows routinely carry freeform: "" — require it.
	if (!raw.freeform?.trim()) return null;
	const address = composeOvertureAddress(raw);
	if (!address) return null;
	return { id: raw.id, name: raw.name ?? null, latitude: raw.lat, longitude: raw.lon, address };
}

// A cache file's raw JSON records stream via the shared streamNdjson with
// `acceptArray` (a JSON array for small hand-made caches) and `skipMalformed`
// (a country-scale NDJSON runs to millions of lines / ~1 GB and must never be
// materialized in memory; a stray junk line is skipped, not fatal).
const RAW_RECORD_OPTS = { acceptArray: true, skipMalformed: true } as const;

/** Streams usable address-pass places; `stats.seen` counts them for the summary line. */
async function* loadPlaces(path: string, stats: { seen: number }): AsyncGenerator<OverturePlace> {
	for await (const raw of streamNdjson<unknown>(path, RAW_RECORD_OPTS)) {
		const p = toPlace(raw as RawPlace);
		if (p) {
			stats.seen++;
			yield p;
		}
	}
}

/** One raw record from the eateries cache (fetch-canada-eateries.py output). */
interface RawEatery {
	id?: string;
	name?: string | null;
	lon?: number;
	lat?: number;
	website?: string | null;
	phone?: string | null;
	social?: string | null;
	category?: string | null;
	operating_status?: string | null;
}

/** Maps a raw eateries record to an {@link OvertureEatery}, or null if unusable. */
function toEatery(raw: RawEatery): OvertureEatery | null {
	if (!raw.id || typeof raw.lon !== 'number' || typeof raw.lat !== 'number') return null;
	return {
		id: raw.id,
		name: raw.name ?? null,
		latitude: raw.lat,
		longitude: raw.lon,
		website: raw.website ?? null,
		phone: raw.phone ?? null,
		social: raw.social ?? null,
		category: raw.category ?? null,
		operating_status: raw.operating_status ?? null
	};
}

/** Streams usable contacts-pass eateries; `stats.seen` counts them for the summary line. */
async function* loadEateries(
	path: string,
	stats: { seen: number }
): AsyncGenerator<OvertureEatery> {
	for await (const raw of streamNdjson<unknown>(path, RAW_RECORD_OPTS)) {
		const e = toEatery(raw as RawEatery);
		if (e) {
			stats.seen++;
			yield e;
		}
	}
}

/** Median of a numeric list (0 when empty), for the summary lines. */
function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** The original address pass: fill missing addresses from the places cache. */
async function runAddressPass(store: OsmPoiStore, args: Args, input: string): Promise<void> {
	const pois = store.addresslessPois();
	console.error(`Address-less POIs in store: ${pois.length}`);

	const stats = { seen: 0 };
	const matches = await matchOverturePlaces(pois, loadPlaces(input, stats), {
		radiusM: args.radiusM,
		releaseLabel: args.release
	});
	console.error(`Overture places streamed from cache: ${stats.seen}`);

	let written = 0;
	if (!args.dryRun) written = store.updateAddresses(matches);

	console.error(
		`\n${args.dryRun ? '[dry-run] would fill' : 'Filled'} ${matches.length} addresses from Overture ` +
			`(${((100 * matches.length) / Math.max(1, pois.length)).toFixed(1)}% of address-less POIs; ` +
			`median match ${median(matches.map((m) => m.distance_m))} m). ` +
			(args.dryRun ? '' : `${written} rows updated. `) +
			`Release: ${args.release}, radius: ${args.radiusM} m.`
	);
}

/**
 * The contacts + identity pass: match EVERY staging POI against the eateries
 * cache, bank each match (overture_id + distance), fill website / phone /
 * cuisine gaps with per-field provenance, and clear LOST matches (previously
 * banked POIs nothing matched this run). Idempotent — see enrich-contacts.ts.
 */
async function runContactsPass(store: OsmPoiStore, args: Args, eateries: string): Promise<void> {
	const pois = store.contactEnrichmentPois();
	console.error(`POIs in store (contacts/identity pass): ${pois.length}`);

	const stats = { seen: 0 };
	const matches = await matchNearestPlaces(pois, loadEateries(eateries, stats), args.radiusM);
	console.error(`Overture eateries streamed from cache: ${stats.seen}`);

	// LOST matches: banked on a previous run, unmatched now (place gone from the
	// feed, or renamed/moved out of relation). Their overture-sourced data would
	// otherwise linger as ghosts of a dead place. A high lost fraction instead
	// signals a partial --eateries file — clearing then would wipe valid
	// enrichment, so a real run aborts unless explicitly allowed.
	const matchedIds = new Set(matches.map((m) => m.osm_id));
	const previouslyBanked = pois.filter((p) => p.overture_id !== null);
	const lost = previouslyBanked.filter((p) => !matchedIds.has(p.osm_id));
	if (massClearExceeded(lost.length, previouslyBanked.length)) {
		const detail =
			`the contacts pass would clear ${lost.length} of ${previouslyBanked.length} previously ` +
			`banked matches (>${Math.round(MASS_CLEAR_FRACTION * 100)}%) — is --eateries a ` +
			`partial/regional file?`;
		if (!args.dryRun && !args.allowMassClear) {
			console.error(`Error: ${detail} Pass --allow-mass-clear to proceed anyway.`);
			process.exit(1);
		}
		console.error(
			`Warning: ${detail}${args.dryRun ? ' A real run would abort without --allow-mass-clear.' : ' Proceeding (--allow-mass-clear).'}`
		);
	}
	const clears = lost.map(planOvertureClear);

	const poiById = new Map(pois.map((p) => [p.osm_id, p]));
	const hadValue = (v: string | null): boolean => v !== null && v.trim() !== '';
	const filled = { website: 0, phone: 0, cuisine: 0 };
	const overtureSourced = { website: 0, phone: 0, cuisine: 0 };
	const updates = [];
	for (const m of matches) {
		const poi = poiById.get(m.osm_id);
		if (!poi) continue; // unreachable: matches come from `pois`
		const u = planOvertureBank(poi, m.place, m.distance_m, args.release);
		if (!hadValue(poi.website) && u.website !== null) filled.website++;
		if (!hadValue(poi.phone) && u.phone !== null) filled.phone++;
		if (!hadValue(poi.cuisine) && u.cuisine !== null) filled.cuisine++;
		if (isOvertureSourced(u.website_source)) overtureSourced.website++;
		if (isOvertureSourced(u.phone_source)) overtureSourced.phone++;
		if (isOvertureSourced(u.cuisine_source)) overtureSourced.cuisine++;
		updates.push(u);
	}

	let written = 0;
	if (!args.dryRun)
		written = store.bankOvertureMatches(updates) + store.clearOvertureMatches(clears);

	console.error(
		`\n${args.dryRun ? '[dry-run] would bank' : 'Banked'} ${updates.length} Overture matches ` +
			`(${((100 * updates.length) / Math.max(1, pois.length)).toFixed(1)}% of POIs; ` +
			`median match ${median(matches.map((m) => m.distance_m)).toFixed(1)} m). ` +
			`Newly filled: ${filled.website} websites, ${filled.phone} phones, ${filled.cuisine} cuisines. ` +
			`Overture-sourced totals: ${overtureSourced.website} websites, ${overtureSourced.phone} phones, ` +
			`${overtureSourced.cuisine} cuisines. ` +
			`Lost matches cleared: ${clears.length}. ` +
			(args.dryRun ? '' : `${written} rows updated. `) +
			`Release: ${args.release}, radius: ${args.radiusM} m.`
	);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	for (const path of [args.input, args.eateries]) {
		if (path && !existsSync(path)) {
			console.error(`Error: cache file not found: ${path}`);
			process.exit(1);
		}
	}
	if (!existsSync(args.db)) {
		console.error(`Error: staging store not found: ${args.db}. Build it first with osm:extract.`);
		process.exit(1);
	}

	const store = OsmPoiStore.open(args.db);
	try {
		if (args.input) await runAddressPass(store, args, args.input);
		if (args.eateries) await runContactsPass(store, args, args.eateries);
	} finally {
		store.close();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
