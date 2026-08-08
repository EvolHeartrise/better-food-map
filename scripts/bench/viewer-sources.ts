/**
 * Data-source metrics API for the bench viewer — how many eateries each
 * ingestion source knows about, how they overlap, and how many remain to
 * ingest, by country → province/state → city. This is the denominator side of
 * "what would it cost to ingest city X": the viewer's bench cells supply the
 * $/menu, these counts supply the venue counts.
 *
 * Reads three LOCAL stores, read-only, no network:
 *   - `data/osm-poi.sqlite` table `osm_poi` — the OSM food-POI staging store
 *     (admin_city/admin_region stamped at extract time).
 *   - same file, table `overture_leads` — Overture venues with NO name-related
 *     OSM staging POI nearby (built that way by scripts/overture/build-leads),
 *     so OSM + leads is a deliberate lower-bound estimate of the union.
 *   - the miniflare D1 mirror under `.wrangler/state` — the map as of the last
 *     `bun run db:pull`; its mtime is reported so staleness is visible instead
 *     of silent.
 *
 * "unique" = osm + leads (union estimate; leads exclude OSM-covered venues by
 * construction). "remaining" = max(0, unique − map open locations), an
 * ESTIMATE: the map keys geography from structured addresses while OSM/Overture
 * carry admin/locality names, and neighbourhood-level names (North York vs
 * Toronto) do not always agree. The response labels it accordingly.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_POI_DB = join('data', 'osm-poi.sqlite');
const MIRROR_DIR = join('.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

/** Newest .sqlite under the miniflare D1 dir — db:pull replaces the file. */
export function findMapMirror(root = '.'): string | null {
	const dir = join(root, MIRROR_DIR);
	if (!existsSync(dir)) return null;
	let best: { path: string; mtime: number } | null = null;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.sqlite')) continue;
		const path = join(dir, name);
		const mtime = statSync(path).mtimeMs;
		if (!best || mtime > best.mtime) best = { path, mtime };
	}
	return best?.path ?? null;
}

/**
 * Accent-and-case fold for joining city names across sources ("Montréal" and
 * "Montreal" are one city). ASCII-safe fold only — this must stay consistent
 * per request, not clever.
 */
export function foldCity(name: string): string {
	return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

interface GeoCount {
	region: string;
	city: string;
	n: number;
}

export interface CityRow {
	city: string;
	osm: number;
	leads: number;
	map_open: number;
	unique_estimate: number;
	remaining_estimate: number;
}

export interface RegionRow {
	region: string;
	osm: number;
	leads: number;
	map_open: number;
	map_closed: number;
	unique_estimate: number;
	remaining_estimate: number;
}

export interface SourcesSummary {
	available: boolean;
	reason?: string;
	sources?: {
		osm: { total: number; named: number; matched_overture: number; db_mtime: string };
		overture_leads: { total: number; release: string | null };
		map: { open: number; closed: number; mirror_mtime: string | null; mirror_found: boolean };
	};
	/** Single-country today (the Canada extract); shaped as a list on purpose. */
	countries?: { country: string; regions: RegionRow[] }[];
	method?: string;
}

const METHOD =
	'unique = OSM staging + Overture leads (leads exclude OSM-covered venues by construction); ' +
	'remaining = max(0, unique − open map locations). Region/city joins fold accents and case; ' +
	'neighbourhood-level names may still split one city across rows, so treat city rows as estimates.';

function geoCounts(db: Database, sql: string): GeoCount[] {
	return (db.query(sql).all() as { region: string | null; city: string | null; n: number }[]).map(
		(row) => ({
			region: (row.region ?? '').trim() || '(unknown)',
			city: (row.city ?? '').trim() || '(unknown)',
			n: row.n
		})
	);
}

interface Loaded {
	osm: GeoCount[];
	leads: GeoCount[];
	mapOpen: GeoCount[];
	mapClosedTotal: number;
	osmTotal: number;
	osmNamed: number;
	osmMatched: number;
	leadsTotal: number;
	leadsRelease: string | null;
	mapOpenTotal: number;
	poiMtime: number;
	mirrorMtime: number | null;
	mirrorFound: boolean;
}

function load(poiDbPath: string, root: string): Loaded | { error: string } {
	if (!existsSync(poiDbPath)) {
		return { error: `${poiDbPath} not found — run \`bun run osm:extract\` to build it` };
	}
	const poi = new Database(poiDbPath, { readonly: true });
	try {
		const osm = geoCounts(
			poi,
			'SELECT admin_region AS region, admin_city AS city, COUNT(*) AS n FROM osm_poi GROUP BY 1, 2'
		);
		const one = (sql: string): number => (poi.query(sql).get() as { n: number }).n;
		const osmTotal = one('SELECT COUNT(*) AS n FROM osm_poi');
		const osmNamed = one("SELECT COUNT(*) AS n FROM osm_poi WHERE name IS NOT NULL AND name != ''");
		const osmMatched = one('SELECT COUNT(*) AS n FROM osm_poi WHERE overture_id IS NOT NULL');

		const hasLeads =
			(
				poi
					.query(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='overture_leads'"
					)
					.get() as { n: number }
			).n > 0;
		const leads = hasLeads
			? geoCounts(
					poi,
					'SELECT province AS region, city, COUNT(*) AS n FROM overture_leads GROUP BY 1, 2'
				)
			: [];
		const leadsTotal = hasLeads ? one('SELECT COUNT(*) AS n FROM overture_leads') : 0;
		const leadsRelease = hasLeads
			? ((
					poi.query('SELECT release FROM overture_leads LIMIT 1').get() as {
						release: string;
					} | null
				)?.release ?? null)
			: null;

		const mirrorPath = findMapMirror(root);
		let mapOpen: GeoCount[] = [];
		let mapOpenTotal = 0;
		let mapClosedTotal = 0;
		let mirrorMtime: number | null = null;
		if (mirrorPath) {
			mirrorMtime = statSync(mirrorPath).mtimeMs;
			const mirror = new Database(mirrorPath, { readonly: true });
			try {
				mapOpen = geoCounts(
					mirror,
					'SELECT region, city, COUNT(*) AS n FROM locations WHERE closed_at IS NULL GROUP BY 1, 2'
				);
				mapOpenTotal = (
					mirror.query('SELECT COUNT(*) AS n FROM locations WHERE closed_at IS NULL').get() as {
						n: number;
					}
				).n;
				mapClosedTotal = (
					mirror.query('SELECT COUNT(*) AS n FROM locations WHERE closed_at IS NOT NULL').get() as {
						n: number;
					}
				).n;
			} finally {
				mirror.close();
			}
		}

		return {
			osm,
			leads,
			mapOpen,
			mapClosedTotal,
			osmTotal,
			osmNamed,
			osmMatched,
			leadsTotal,
			leadsRelease,
			mapOpenTotal,
			poiMtime: statSync(poiDbPath).mtimeMs,
			mirrorMtime,
			mirrorFound: mirrorPath !== null
		};
	} finally {
		poi.close();
	}
}

function sumByRegion(rows: GeoCount[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const row of rows) out.set(row.region, (out.get(row.region) ?? 0) + row.n);
	return out;
}

export function buildSummary(loaded: Loaded): SourcesSummary {
	const osmByRegion = sumByRegion(loaded.osm);
	const leadsByRegion = sumByRegion(loaded.leads);
	const mapByRegion = sumByRegion(loaded.mapOpen);
	const regionsSeen = new Set([
		...osmByRegion.keys(),
		...leadsByRegion.keys(),
		...mapByRegion.keys()
	]);

	const regions: RegionRow[] = [...regionsSeen]
		.map((region) => {
			const osm = osmByRegion.get(region) ?? 0;
			const leads = leadsByRegion.get(region) ?? 0;
			const mapOpen = mapByRegion.get(region) ?? 0;
			const unique = osm + leads;
			return {
				region,
				osm,
				leads,
				map_open: mapOpen,
				map_closed: 0,
				unique_estimate: unique,
				remaining_estimate: Math.max(0, unique - mapOpen)
			};
		})
		.toSorted((a, b) => b.unique_estimate - a.unique_estimate);

	return {
		available: true,
		sources: {
			osm: {
				total: loaded.osmTotal,
				named: loaded.osmNamed,
				matched_overture: loaded.osmMatched,
				db_mtime: new Date(loaded.poiMtime).toISOString()
			},
			overture_leads: { total: loaded.leadsTotal, release: loaded.leadsRelease },
			map: {
				open: loaded.mapOpenTotal,
				closed: loaded.mapClosedTotal,
				mirror_mtime:
					loaded.mirrorMtime === null ? null : new Date(loaded.mirrorMtime).toISOString(),
				mirror_found: loaded.mirrorFound
			}
		},
		countries: [{ country: 'CA', regions }],
		method: METHOD
	};
}

/** City drill-down for one region, joined across sources on the folded name. */
export function buildCities(loaded: Loaded, region: string): CityRow[] {
	const cities = new Map<string, CityRow>();
	const rowFor = (city: string): CityRow => {
		const key = foldCity(city);
		let row = cities.get(key);
		if (!row) {
			row = { city, osm: 0, leads: 0, map_open: 0, unique_estimate: 0, remaining_estimate: 0 };
			cities.set(key, row);
		}
		return row;
	};
	for (const entry of loaded.osm) if (entry.region === region) rowFor(entry.city).osm += entry.n;
	for (const entry of loaded.leads)
		if (entry.region === region) rowFor(entry.city).leads += entry.n;
	for (const entry of loaded.mapOpen)
		if (entry.region === region) rowFor(entry.city).map_open += entry.n;
	const rows = [...cities.values()];
	for (const row of rows) {
		row.unique_estimate = row.osm + row.leads;
		row.remaining_estimate = Math.max(0, row.unique_estimate - row.map_open);
	}
	return rows.toSorted((a, b) => b.unique_estimate - a.unique_estimate);
}

// --- handler --------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/**
 * Loaded counts, cached on the two files' mtimes: the staging store changes on
 * re-extract and the mirror on db:pull — a viewer session in between reads the
 * same data, so re-querying 120k rows per request would be waste.
 */
export class SourcesCache {
	private cached: { key: string; loaded: Loaded } | null = null;

	constructor(
		private readonly poiDbPath = DEFAULT_POI_DB,
		private readonly root = '.'
	) {}

	get(): Loaded | { error: string } {
		const mirror = findMapMirror(this.root);
		const key = [
			existsSync(this.poiDbPath) ? statSync(this.poiDbPath).mtimeMs : 'absent',
			mirror ? statSync(mirror).mtimeMs : 'absent'
		].join('|');
		if (this.cached?.key === key) return this.cached.loaded;
		const loaded = load(this.poiDbPath, this.root);
		if ('error' in loaded) return loaded;
		this.cached = { key, loaded };
		return loaded;
	}
}

/** Handle an `/api/sources/*` request; null when the path is not ours. */
export function handleSources(url: URL, cache: SourcesCache): Response | null {
	const { pathname } = url;
	if (!pathname.startsWith('/api/sources/')) return null;

	const loaded = cache.get();
	if ('error' in loaded) {
		return json({ available: false, reason: loaded.error });
	}

	switch (pathname) {
		case '/api/sources/summary':
			return json(buildSummary(loaded));

		case '/api/sources/cities': {
			const region = url.searchParams.get('region');
			if (!region) return json({ error: 'missing region' }, 400);
			return json({ region, cities: buildCities(loaded, region) });
		}

		default:
			return json({ error: `no such endpoint: ${pathname}` }, 404);
	}
}
