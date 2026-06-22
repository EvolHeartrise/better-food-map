/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// Builds (or refreshes) the local OSM food-POI staging store for one region.
//
//   bun run osm:extract --region canada --input british-columbia-latest.osm.pbf
//
// Pipeline:
//   1. osmium tags-filter  — keep only food POIs (FOOD_AMENITIES / FOOD_SHOPS)
//   2. osmium export       — emit one GeoJSON feature per line (geojsonseq)
//   3. load                — map each feature to a row and REPLACE the region in
//                            the staging DB (default data/osm-poi.sqlite, gitignored)
//
// Requires the `osmium` CLI (osmium-tool). Download region extracts from
// https://download.geofabrik.de/ (e.g. north-america/canada-latest.osm.pbf).
// The staging DB is disposable — only curated rows reach D1 via the MCP server.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FOOD_AMENITIES, FOOD_SHOPS, type PoiRow } from './osm/map-feature';
import { parseFeatureLine } from './osm/load-geojson';
import { OsmPoiStore } from './osm/poi-store';

interface Args {
	region: string;
	input: string;
	db: string;
	keepTemp: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Partial<Args> = { db: 'data/osm-poi.sqlite', keepTemp: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case '--region':
				args.region = argv[++i];
				break;
			case '--input':
				args.input = argv[++i];
				break;
			case '--db':
				args.db = argv[++i];
				break;
			case '--keep-temp':
				args.keepTemp = true;
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
	if (!args.region || !args.input) {
		console.error('Error: --region and --input are required.\n');
		printUsageAndExit(1);
	}
	return args as Args;
}

function printUsageAndExit(code: number): never {
	console.error(
		'Usage: bun run osm:extract --region <name> --input <file.osm.pbf> [--db <path>] [--keep-temp]\n' +
			'\n' +
			'  --region     Label stored on each row (e.g. "canada"); re-running replaces it.\n' +
			'  --input      Geofabrik .osm.pbf extract (https://download.geofabrik.de/).\n' +
			'  --db         Staging SQLite path (default: data/osm-poi.sqlite).\n' +
			'  --keep-temp  Keep the intermediate filtered .pbf / .geojsonl files.\n'
	);
	process.exit(code);
}

/** Runs a command, streaming its output, and throws on a non-zero exit. */
async function run(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`\`${cmd.join(' ')}\` exited with code ${code}`);
}

/** Yields the file's lines without buffering the whole thing in memory. */
async function* readLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buf = '';
	const stream = Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>;
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf('\n');
		while (nl >= 0) {
			yield buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf('\n');
		}
	}
	buf += decoder.decode();
	if (buf.length) yield buf;
}

const BATCH_SIZE = 5000;

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));

	if (!Bun.which('osmium')) {
		console.error(
			'Error: `osmium` not found on PATH. Install osmium-tool:\n' +
				'  Debian/Ubuntu:  sudo apt-get install osmium-tool\n' +
				'  macOS (brew):   brew install osmium-tool\n'
		);
		process.exit(1);
	}
	if (!existsSync(args.input)) {
		console.error(`Error: input file not found: ${args.input}`);
		process.exit(1);
	}

	const tmpDir = join(dirname(args.db || '.') || '.', '.osm-tmp');
	await mkdir(tmpDir, { recursive: true });
	await mkdir(dirname(args.db) || '.', { recursive: true });
	const filteredPbf = join(tmpDir, `${args.region}.food.osm.pbf`);
	const geojsonl = join(tmpDir, `${args.region}.food.geojsonl`);

	// 1. Filter to food POIs only (nodes, ways and relations).
	const amenityFilter = `nwr/amenity=${FOOD_AMENITIES.join(',')}`;
	const shopFilter = `nwr/shop=${FOOD_SHOPS.join(',')}`;
	console.error(`[1/3] Filtering food POIs from ${args.input} ...`);
	await run([
		'osmium',
		'tags-filter',
		args.input,
		amenityFilter,
		shopFilter,
		'-o',
		filteredPbf,
		'--overwrite'
	]);

	// 2. Export to one GeoJSON feature per line, with type-prefixed ids.
	console.error('[2/3] Exporting to GeoJSON ...');
	await run([
		'osmium',
		'export',
		filteredPbf,
		'-f',
		'geojsonseq',
		'-u',
		'type_id',
		'-o',
		geojsonl,
		'--overwrite'
	]);

	// 3. Load into the staging store, replacing this region's rows.
	console.error(`[3/3] Loading into ${args.db} (region "${args.region}") ...`);
	const store = OsmPoiStore.open(args.db);
	store.deleteRegion(args.region);
	let inserted = 0;
	let skipped = 0;
	let batch: PoiRow[] = [];
	for await (const line of readLines(geojsonl)) {
		const row = parseFeatureLine(line);
		if (row) {
			batch.push(row);
			if (batch.length >= BATCH_SIZE) {
				inserted += store.insertMany(args.region, batch);
				batch = [];
			}
		} else if (line.trim()) {
			skipped++;
		}
	}
	if (batch.length) inserted += store.insertMany(args.region, batch);

	const total = store.count();
	store.close();

	if (!args.keepTemp) await rm(tmpDir, { recursive: true, force: true });

	console.error(
		`\nDone. Loaded ${inserted} food POIs for "${args.region}" ` +
			`(${skipped} features skipped). Store now holds ${total} POIs across ` +
			`regions. DB: ${args.db}`
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
