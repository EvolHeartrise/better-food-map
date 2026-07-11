// ---------------------------------------------------------------------------
// The `overture_leads` table INSIDE the OSM staging store (data/osm-poi.sqlite):
// the deduped Overture coverage-gap pool built by build-leads.ts, kept in the
// same SQLite file as osm_poi so the MCP server reads it with zero new file
// plumbing. Like the staging store itself it is DISPOSABLE and regenerable —
// rebuilds are drop-and-recreate.
//
// Backed by bun:sqlite, so this module is Bun-only and must never be imported
// into the SvelteKit/Worker bundle.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { Bounds } from '../osm/geo';
import type { OvertureLead } from './leads';

const SCHEMA = `
CREATE TABLE overture_leads (
	overture_id TEXT PRIMARY KEY,
	name TEXT,
	brand_name TEXT,
	brand_wikidata TEXT,
	category TEXT NOT NULL,
	bucket TEXT NOT NULL,
	confidence REAL NOT NULL,
	latitude REAL NOT NULL,
	longitude REAL NOT NULL,
	street TEXT,
	city TEXT,
	region TEXT,
	postcode TEXT,
	province TEXT NOT NULL,
	website TEXT,
	phone TEXT,
	primary_dataset TEXT NOT NULL,
	dup_count INTEGER NOT NULL DEFAULT 1,
	release TEXT NOT NULL
);
CREATE INDEX idx_overture_leads_lat ON overture_leads (latitude);
CREATE INDEX idx_overture_leads_lon ON overture_leads (longitude);
CREATE INDEX idx_overture_leads_province ON overture_leads (province);
`;

const LEAD_COLUMNS =
	'overture_id, name, brand_name, brand_wikidata, category, bucket, confidence, ' +
	'latitude, longitude, street, city, region, postcode, province, website, phone, ' +
	'primary_dataset, dup_count, release';

/** Hard cap on rows scanned back from one query (defends against runaway output). */
export const LEADS_SCAN_CAP = 60_000;

/** Filters for a leads query (all optional; combined with AND). */
export interface LeadsQuery {
	/** Case-insensitive substring match on the lead name OR brand name. */
	name?: string;
	/** Case-insensitive substring match on the Overture locality. */
	city?: string;
	/** Exact match on the resolved province code (e.g. "BC"). */
	province?: string;
	/** Confidence floor for rows carrying a brand signal (brand_wikidata or brand_name). */
	brandedMinConfidence: number;
	/** Confidence floor for independents (no brand signal) — the junk guard. */
	independentMinConfidence: number;
	/** Only rows carrying a brand signal. */
	brandsOnly?: boolean;
	/** Row-scan cap override (testing only). */
	cap?: number;
}

export class OvertureLeadsStore {
	private constructor(private readonly db: Database) {}

	/** Opens (creating the file if needed) a writable store, for the builder. */
	static open(path: string): OvertureLeadsStore {
		const db = new Database(path, { create: true });
		db.exec('PRAGMA journal_mode = WAL;');
		return new OvertureLeadsStore(db);
	}

	/**
	 * Opens an existing store read-only (used by the MCP tool). Throws a clear,
	 * actionable error when the file or the leads table is missing, rather than
	 * failing obscurely at query time.
	 */
	static openReadonly(path: string): OvertureLeadsStore {
		if (!existsSync(path)) {
			throw new Error(
				`No OSM POI store at "${path}". Build one first with \`bun run osm:extract\`, ` +
					`then build the leads table with: bun scripts/overture/build-leads.ts`
			);
		}
		const db = new Database(path, { readonly: true });
		const table = db
			.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'overture_leads'`)
			.get();
		if (!table) {
			db.close();
			throw new Error(
				`No overture_leads table in "${path}". Build it first with: ` +
					`bun scripts/overture/build-leads.ts`
			);
		}
		return new OvertureLeadsStore(db);
	}

	/**
	 * Replaces the whole table with `leads` (drop-and-recreate, one transaction) —
	 * idempotent, so re-running the builder is always safe. Returns rows inserted.
	 */
	rebuild(leads: Iterable<OvertureLead>): number {
		const run = this.db.transaction((rows: Iterable<OvertureLead>) => {
			this.db.run('DROP TABLE IF EXISTS overture_leads');
			this.db.exec(SCHEMA);
			const insert = this.db.prepare(
				`INSERT INTO overture_leads (${LEAD_COLUMNS})
				 VALUES ($overture_id, $name, $brand_name, $brand_wikidata, $category, $bucket,
					 $confidence, $latitude, $longitude, $street, $city, $region, $postcode,
					 $province, $website, $phone, $primary_dataset, $dup_count, $release)`
			);
			let n = 0;
			for (const lead of rows) {
				insert.run({
					$overture_id: lead.overture_id,
					$name: lead.name,
					$brand_name: lead.brand_name,
					$brand_wikidata: lead.brand_wikidata,
					$category: lead.category,
					$bucket: lead.bucket,
					$confidence: lead.confidence,
					$latitude: lead.latitude,
					$longitude: lead.longitude,
					$street: lead.street,
					$city: lead.city,
					$region: lead.region,
					$postcode: lead.postcode,
					$province: lead.province,
					$website: lead.website,
					$phone: lead.phone,
					$primary_dataset: lead.primary_dataset,
					$dup_count: lead.dup_count,
					$release: lead.release
				});
				n++;
			}
			return n;
		});
		return run(leads);
	}

	/** Total leads stored. */
	count(): number {
		const row = this.db.query('SELECT COUNT(*) AS n FROM overture_leads').get();
		return (row as { n: number }).n;
	}

	/**
	 * Leads whose point falls inside `bbox`, filtered per `query`, ordered
	 * best-first (confidence desc, then dup_count desc — more collapsed rows is a
	 * stronger existence signal — then overture_id for deterministic paging).
	 * Capped; callers refine to an exact radius / dedup / page afterwards.
	 */
	searchBbox(bbox: Bounds, query: LeadsQuery): OvertureLead[] {
		const branded = '(brand_wikidata IS NOT NULL OR brand_name IS NOT NULL)';
		const where = [
			'latitude BETWEEN ? AND ?',
			'longitude BETWEEN ? AND ?',
			// The junk guard rides the row's brand signal: branded rows use one
			// confidence floor, independents another (see search-leads.ts).
			`confidence >= CASE WHEN ${branded} THEN ? ELSE ? END`
		];
		const params: unknown[] = [
			bbox.minLat,
			bbox.maxLat,
			bbox.minLng,
			bbox.maxLng,
			query.brandedMinConfidence,
			query.independentMinConfidence
		];
		// LIKE is case-insensitive for ASCII in SQLite by default; ESCAPE binds to
		// each LIKE individually (mirrors poi-store.searchBbox).
		if (query.name) {
			where.push("(name LIKE ? ESCAPE '\\' OR brand_name LIKE ? ESCAPE '\\')");
			const pattern = `%${escapeLike(query.name)}%`;
			params.push(pattern, pattern);
		}
		if (query.city) {
			where.push("city LIKE ? ESCAPE '\\'");
			params.push(`%${escapeLike(query.city)}%`);
		}
		if (query.province) {
			where.push('province = ?');
			params.push(query.province.toUpperCase());
		}
		if (query.brandsOnly) where.push(branded);
		params.push(Math.max(1, query.cap ?? LEADS_SCAN_CAP));

		return this.db
			.query(
				`SELECT ${LEAD_COLUMNS} FROM overture_leads
				 WHERE ${where.join(' AND ')}
				 ORDER BY confidence DESC, dup_count DESC, overture_id
				 LIMIT ?`
			)
			.all(...params) as OvertureLead[];
	}

	close(): void {
		this.db.close();
	}
}

/** Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`; as in poi-store). */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
