/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// overture:enrich — fill missing addresses in the local OSM POI staging store
// from a local Overture Maps "places" cache.
//
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
// After running this, find_missing_address surfaces the filled addresses (with
// `address_source` set) so existing locations can be backfilled, and search_poi
// candidates carry them for new imports — all through the existing tooling.
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
	composeOvertureAddress,
	type OverturePlace
} from './overture/match-overture';

interface Args {
	db: string;
	input: string;
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
	if (!args.input || !args.release) {
		console.error('Error: --input and --release are required.\n');
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
		'Usage: bun run overture:enrich --input <places.ndjson> --release <id> [--db <path>] [--radius-m <m>] [--dry-run]\n' +
			'\n' +
			'  --input     Local Overture places cache (NDJSON or JSON array; see header for the DuckDB fetch).\n' +
			'  --release   Overture release id, recorded in each address_source citation (e.g. 2026-06-17.0).\n' +
			'  --db        Staging SQLite path (default: data/osm-poi.sqlite).\n' +
			'  --radius-m  Max distance for a POI↔place match (default 100).\n' +
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
 * Streams the cache as an async generator (newline-delimited JSON, or a JSON
 * array for small hand-made caches) — a country-scale NDJSON runs to millions
 * of lines / ~1 GB, which must never be materialized in memory. `stats.seen`
 * counts usable places for the summary line.
 */
async function* loadPlaces(path: string, stats: { seen: number }): AsyncGenerator<OverturePlace> {
	const head = Bun.file(path).slice(0, 1);
	const isArray = (await head.text()).trimStart().startsWith('[');
	if (isArray) {
		for (const raw of JSON.parse(await Bun.file(path).text()) as RawPlace[]) {
			const p = toPlace(raw);
			if (p) {
				stats.seen++;
				yield p;
			}
		}
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
				const p = toPlace(JSON.parse(line) as RawPlace);
				if (p) {
					stats.seen++;
					yield p;
				}
			} catch {
				// skip malformed line
			}
		}
	}
	buf += decoder.decode();
	if (buf.trim()) {
		try {
			const p = toPlace(JSON.parse(buf) as RawPlace);
			if (p) {
				stats.seen++;
				yield p;
			}
		} catch {
			// skip malformed tail
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	if (!existsSync(args.input)) {
		console.error(`Error: cache file not found: ${args.input}`);
		process.exit(1);
	}
	if (!existsSync(args.db)) {
		console.error(`Error: staging store not found: ${args.db}. Build it first with osm:extract.`);
		process.exit(1);
	}

	const store = OsmPoiStore.open(args.db);
	const pois = store.addresslessPois();
	console.error(`Address-less POIs in store: ${pois.length}`);

	const stats = { seen: 0 };
	const matches = await matchOverturePlaces(pois, loadPlaces(args.input, stats), {
		radiusM: args.radiusM,
		releaseLabel: args.release
	});
	console.error(`Overture places streamed from cache: ${stats.seen}`);

	// Distance summary for a quick confidence read.
	const dists = matches.map((m) => m.distance_m).toSorted((a, b) => a - b);
	const median = dists.length ? dists[Math.floor(dists.length / 2)] : 0;

	let written = 0;
	if (!args.dryRun) written = store.updateAddresses(matches);
	store.close();

	console.error(
		`\n${args.dryRun ? '[dry-run] would fill' : 'Filled'} ${matches.length} addresses from Overture ` +
			`(${((100 * matches.length) / Math.max(1, pois.length)).toFixed(1)}% of address-less POIs; ` +
			`median match ${median} m). ` +
			(args.dryRun ? '' : `${written} rows updated. `) +
			`Release: ${args.release}, radius: ${args.radiusM} m.`
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
