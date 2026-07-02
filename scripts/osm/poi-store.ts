/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// Local SQLite staging store for OSM food POIs.
//
// This is a DISPOSABLE, regenerable index — NOT the production database. Raw OSM
// candidates live here (single local file, gitignored under data/); only curated
// rows ever cross into D1, via the MCP server's create_locations. Rebuild it any
// time with `bun run osm:extract`.
//
// Backed by bun:sqlite, so this module is Bun-only and must never be imported
// into the SvelteKit/Worker bundle.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { Bbox } from './geo';
import type { PoiRow, SuggestedCategory } from './map-feature';

/** A POI row read back from the store (diet_markers parsed from its JSON column). */
export interface StoredPoi {
	osm_id: string;
	osm_type: 'node' | 'way' | 'relation';
	numeric_id: number;
	name: string | null;
	osm_class: string;
	suggested_category: SuggestedCategory | null;
	cuisine: string | null;
	latitude: number;
	longitude: number;
	address: string | null;
	phone: string | null;
	website: string | null;
	opening_hours: string | null;
	/**
	 * Where `address` came from when it was filled by enrichment rather than the
	 * POI's own OSM tags: null = the POI's own OSM addr:* (or an OSM building it
	 * sits in); a non-null label (e.g. "overture:<id> (2026-06-17.0)") = an
	 * external feed, to be cited as a distinct source when backfilling.
	 */
	address_source: string | null;
	/**
	 * Municipality this POI sits in, from a point-in-polygon join against OSM
	 * admin boundaries at extract time (see osm/enrich-admin.ts) — the "OSM admin
	 * context" fallback for POIs whose own tags/enrichment carry no city.
	 */
	admin_city: string | null;
	/** Province/state from the same admin-boundary join (2-letter code when resolvable). */
	admin_region: string | null;
	diet_markers: string[];
	/** Full original OSM tag set, JSON-encoded — the source of the POI's own `addr:*` parts. */
	tags_json: string;
	region: string;
}

/** Filters for a bounding-box query (all optional; combined with AND). */
export interface BboxQuery {
	category?: SuggestedCategory;
	/** Case-insensitive substring match on the POI name. */
	name?: string;
	/** Case-insensitive substring match on the cuisine tag. */
	cuisine?: string;
	/**
	 * Exact match on the POI's OSM `brand:wikidata` tag (a Wikidata QID like
	 * "Q37158") — surfaces a chain's branches regardless of how each POI is
	 * named. Extracted from `tags_json` at query time.
	 */
	brand_wikidata?: string;
	/** Hard cap on rows scanned back from the box (defends against huge boxes). */
	cap?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS osm_poi (
	osm_id TEXT PRIMARY KEY,
	osm_type TEXT NOT NULL,
	numeric_id INTEGER NOT NULL,
	name TEXT,
	osm_class TEXT NOT NULL,
	suggested_category TEXT,
	cuisine TEXT,
	latitude REAL NOT NULL,
	longitude REAL NOT NULL,
	address TEXT,
	phone TEXT,
	website TEXT,
	opening_hours TEXT,
	diet_markers TEXT NOT NULL DEFAULT '[]',
	tags_json TEXT NOT NULL DEFAULT '{}',
	address_source TEXT,
	admin_city TEXT,
	admin_region TEXT,
	region TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_poi_lat ON osm_poi (latitude);
CREATE INDEX IF NOT EXISTS idx_osm_poi_lon ON osm_poi (longitude);
CREATE INDEX IF NOT EXISTS idx_osm_poi_region ON osm_poi (region);
`;

const DEFAULT_CAP = 2000;

/** Row shape as stored in SQLite (diet_markers still JSON text). */
interface RawStoredRow extends Omit<StoredPoi, 'diet_markers'> {
	diet_markers: string;
}

export class OsmPoiStore {
	private constructor(private readonly db: Database) {}

	/** Opens (creating if needed) a writable store and ensures the schema exists. */
	static open(path: string): OsmPoiStore {
		const db = new Database(path, { create: true });
		db.exec('PRAGMA journal_mode = WAL;');
		db.run(SCHEMA);
		// Additive migrations for stores created before a column existed: the
		// CREATE TABLE IF NOT EXISTS above won't add columns to an existing table.
		// `ALTER TABLE ADD COLUMN` throws "duplicate column name" once applied, which
		// we ignore — making this idempotent across re-opens.
		for (const ddl of [
			'ALTER TABLE osm_poi ADD COLUMN address_source TEXT',
			'ALTER TABLE osm_poi ADD COLUMN admin_city TEXT',
			'ALTER TABLE osm_poi ADD COLUMN admin_region TEXT'
		]) {
			try {
				db.run(ddl);
			} catch {
				// column already present
			}
		}
		return new OsmPoiStore(db);
	}

	/**
	 * Opens an existing store read-only (used by the MCP tool). Throws a clear,
	 * actionable error if the file is missing rather than silently creating an
	 * empty one.
	 */
	static openReadonly(path: string): OsmPoiStore {
		if (!existsSync(path)) {
			throw new Error(
				`No OSM POI store at "${path}". Build one first with: ` +
					`bun run osm:extract --region <name> --input <region>.osm.pbf ` +
					`(or set OSM_POI_DB to an existing store).`
			);
		}
		return new OsmPoiStore(new Database(path, { readonly: true }));
	}

	/** Inserts/updates a batch of rows for a region (no prior delete). */
	insertMany(region: string, rows: Iterable<PoiRow>): number {
		const insert = this.db.prepare(
			`INSERT OR REPLACE INTO osm_poi
				(osm_id, osm_type, numeric_id, name, osm_class, suggested_category, cuisine,
				 latitude, longitude, address, phone, website, opening_hours, diet_markers, tags_json,
				 admin_city, admin_region, region)
			 VALUES ($osm_id, $osm_type, $numeric_id, $name, $osm_class, $suggested_category, $cuisine,
				 $latitude, $longitude, $address, $phone, $website, $opening_hours, $diet_markers, $tags_json,
				 $admin_city, $admin_region, $region)`
		);
		const run = this.db.transaction((items: Iterable<PoiRow>) => {
			let n = 0;
			for (const r of items) {
				insert.run({
					$osm_id: r.osm_id,
					$osm_type: r.osm_type,
					$numeric_id: r.numeric_id,
					$name: r.name,
					$osm_class: r.osm_class,
					$suggested_category: r.suggested_category,
					$cuisine: r.cuisine,
					$latitude: r.latitude,
					$longitude: r.longitude,
					$address: r.address,
					$phone: r.phone,
					$website: r.website,
					$opening_hours: r.opening_hours,
					$diet_markers: JSON.stringify(r.diet_markers ?? []),
					$tags_json: r.tags_json,
					$admin_city: r.admin_city,
					$admin_region: r.admin_region,
					$region: region
				});
				n++;
			}
			return n;
		});
		return run(rows);
	}

	/**
	 * Fills `address` (and records its `address_source`) on existing rows, keyed by
	 * osm_id, in one transaction. Used by enrichment passes (e.g. overture:enrich)
	 * that add addresses to POIs lacking their own. Returns rows actually updated.
	 */
	updateAddresses(
		updates: Iterable<{ osm_id: string; address: string; address_source: string | null }>
	): number {
		const stmt = this.db.prepare(
			'UPDATE osm_poi SET address = $address, address_source = $address_source WHERE osm_id = $osm_id'
		);
		const run = this.db.transaction(
			(items: Iterable<{ osm_id: string; address: string; address_source: string | null }>) => {
				let n = 0;
				for (const u of items) {
					n += stmt.run({
						$address: u.address,
						$address_source: u.address_source,
						$osm_id: u.osm_id
					}).changes;
				}
				return n;
			}
		);
		return run(updates);
	}

	/** Removes every row of a region. Returns the number deleted. */
	deleteRegion(region: string): number {
		return this.db.run('DELETE FROM osm_poi WHERE region = ?', [region]).changes;
	}

	/** Total rows, optionally for a single region. */
	count(region?: string): number {
		const row = region
			? this.db.query('SELECT COUNT(*) AS n FROM osm_poi WHERE region = ?').get(region)
			: this.db.query('SELECT COUNT(*) AS n FROM osm_poi').get();
		return (row as { n: number }).n;
	}

	/**
	 * Every POI lacking a usable address (its `address` is NULL or blank), across
	 * all regions. Used by enrichment passes (overture:enrich) to find the work set.
	 */
	addresslessPois(): {
		osm_id: string;
		name: string | null;
		latitude: number;
		longitude: number;
	}[] {
		return this.db
			.query(
				`SELECT osm_id, name, latitude, longitude FROM osm_poi
				 WHERE address IS NULL OR TRIM(address) = ''`
			)
			.all() as { osm_id: string; name: string | null; latitude: number; longitude: number }[];
	}

	/** Distinct region labels currently loaded. */
	regions(): string[] {
		const rows = this.db.query('SELECT DISTINCT region FROM osm_poi ORDER BY region').all() as {
			region: string;
		}[];
		return rows.map((r) => r.region);
	}

	/**
	 * Rows whose point falls inside `bbox`, with optional category/name/cuisine
	 * filters. Capped (default 2000) so a careless huge box can't load the world;
	 * callers refine to an exact radius and de-duplicate afterwards.
	 */
	searchBbox(bbox: Bbox, query: BboxQuery = {}): StoredPoi[] {
		const where = ['latitude BETWEEN ? AND ?', 'longitude BETWEEN ? AND ?'];
		const params: unknown[] = [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon];
		if (query.category) {
			where.push('suggested_category = ?');
			params.push(query.category);
		}
		// LIKE is case-insensitive for ASCII in SQLite by default; ESCAPE binds to
		// each LIKE individually (a single trailing ESCAPE would be a syntax error).
		if (query.name) {
			where.push("name LIKE ? ESCAPE '\\'");
			params.push(`%${escapeLike(query.name)}%`);
		}
		if (query.cuisine) {
			where.push("cuisine LIKE ? ESCAPE '\\'");
			params.push(`%${escapeLike(query.cuisine)}%`);
		}
		if (query.brand_wikidata) {
			// UPPER on both sides: lower-case "q175106" tags exist in the wild.
			where.push(`UPPER(json_extract(tags_json, '$."brand:wikidata"')) = ?`);
			params.push(query.brand_wikidata.toUpperCase());
		}
		params.push(Math.max(1, query.cap ?? DEFAULT_CAP));

		const rows = this.db
			.query(
				`SELECT osm_id, osm_type, numeric_id, name, osm_class, suggested_category, cuisine,
					latitude, longitude, address, phone, website, opening_hours, address_source,
					admin_city, admin_region, diet_markers, tags_json, region
				 FROM osm_poi
				 WHERE ${where.join(' AND ')}
				 LIMIT ?`
			)
			.all(...params) as RawStoredRow[];

		return rows.map((r) => ({ ...r, diet_markers: parseMarkers(r.diet_markers) }));
	}

	/**
	 * A single POI by its `osm_id` (the staging-store primary key, as returned by
	 * search_poi), or null when absent. Used by create_locations' import path to
	 * take coordinates + address VERBATIM from OSM rather than trusting the caller
	 * to copy them through.
	 */
	getByOsmId(osmId: string): StoredPoi | null {
		const row = this.db
			.query(
				`SELECT osm_id, osm_type, numeric_id, name, osm_class, suggested_category, cuisine,
					latitude, longitude, address, phone, website, opening_hours, address_source,
					admin_city, admin_region, diet_markers, tags_json, region
				 FROM osm_poi WHERE osm_id = ?`
			)
			.get(osmId) as RawStoredRow | null;
		return row ? { ...row, diet_markers: parseMarkers(row.diet_markers) } : null;
	}

	close(): void {
		this.db.close();
	}
}

/** Parses the diet_markers JSON column defensively (corrupt → empty). */
function parseMarkers(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

/** Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`). */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
