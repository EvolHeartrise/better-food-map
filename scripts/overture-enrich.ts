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
// recomputed on every run, so re-runs are idempotent (see
// scripts/overture/enrich-contacts.ts). US-spillover NDJSON rows need no
// pre-filter: a match requires a name-related staging POI within the radius,
// which is anchor enough. Coordinates are, as always, untouched.
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
import { OsmPoiStore } from './osm/poi-store';
import {
	matchOverturePlaces,
	matchNearestPlaces,
	composeOvertureAddress,
	type OverturePlace
} from './overture/match-overture';
import {
	planOvertureBank,
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
}

function parseArgs(argv: string[]): Args {
	const args: Partial<Args> = { db: 'data/osm-poi.sqlite', radiusM: 100, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case '--db':
				args.db = argv[++i];
				break;
			case '--input':
				args.input = argv[++i];
				break;
			case '--eateries':
				args.eateries = argv[++i];
				break;
			case '--radius-m':
				args.radiusM = Number(argv[++i]);
				break;
			case '--release':
				args.release = argv[++i];
				break;
			case '--dry-run':
				args.dryRun = true;
				break;
			case '--help':
			case '-h':
				printUsageAndExit(0);
				break;
			default:
				console.error(`Unknown argument: ${a}`);
				printUsageAndExit(1);
		}
	}
	if ((!args.input && !args.eateries) || !args.release) {
		console.error('Error: --release and at least one of --input / --eateries are required.\n');
		printUsageAndExit(1);
	}
	if (!Number.isFinite(args.radiusM) || (args.radiusM ?? 0) <= 0) {
		console.error('Error: --radius-m must be a positive number.\n');
		printUsageAndExit(1);
	}
	return args as Args;
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
			'  --dry-run   Report what would be filled without writing.\n'
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

/**
 * Streams a cache file's raw JSON records (newline-delimited JSON, or a JSON
 * array for small hand-made caches) — a country-scale NDJSON runs to millions
 * of lines / ~1 GB, which must never be materialized in memory. Malformed
 * lines are skipped.
 */
async function* rawRecords(path: string): AsyncGenerator<unknown> {
	const head = Bun.file(path).slice(0, 1);
	const isArray = (await head.text()).trimStart().startsWith('[');
	if (isArray) {
		yield* JSON.parse(await Bun.file(path).text()) as unknown[];
		return;
	}
	const decoder = new TextDecoder();
	let buf = '';
	const stream = Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>;
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf('\n');
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf('\n');
			if (!line.trim()) continue;
			try {
				yield JSON.parse(line);
			} catch {
				// skip malformed line
			}
		}
	}
	buf += decoder.decode();
	if (buf.trim()) {
		try {
			yield JSON.parse(buf);
		} catch {
			// skip malformed tail
		}
	}
}

/** Streams usable address-pass places; `stats.seen` counts them for the summary line. */
async function* loadPlaces(path: string, stats: { seen: number }): AsyncGenerator<OverturePlace> {
	for await (const raw of rawRecords(path)) {
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
		category: raw.category ?? null
	};
}

/** Streams usable contacts-pass eateries; `stats.seen` counts them for the summary line. */
async function* loadEateries(
	path: string,
	stats: { seen: number }
): AsyncGenerator<OvertureEatery> {
	for await (const raw of rawRecords(path)) {
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
 * cache, bank each match (overture_id + distance), and fill website / phone /
 * cuisine gaps with per-field provenance. Idempotent — see enrich-contacts.ts.
 */
async function runContactsPass(store: OsmPoiStore, args: Args, eateries: string): Promise<void> {
	const pois = store.contactEnrichmentPois();
	console.error(`POIs in store (contacts/identity pass): ${pois.length}`);

	const stats = { seen: 0 };
	const matches = await matchNearestPlaces(pois, loadEateries(eateries, stats), args.radiusM);
	console.error(`Overture eateries streamed from cache: ${stats.seen}`);

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
	if (!args.dryRun) written = store.bankOvertureMatches(updates);

	console.error(
		`\n${args.dryRun ? '[dry-run] would bank' : 'Banked'} ${updates.length} Overture matches ` +
			`(${((100 * updates.length) / Math.max(1, pois.length)).toFixed(1)}% of POIs; ` +
			`median match ${median(matches.map((m) => m.distance_m)).toFixed(1)} m). ` +
			`Newly filled: ${filled.website} websites, ${filled.phone} phones, ${filled.cuisine} cuisines. ` +
			`Overture-sourced totals: ${overtureSourced.website} websites, ${overtureSourced.phone} phones, ` +
			`${overtureSourced.cuisine} cuisines. ` +
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
