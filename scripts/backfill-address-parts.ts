/// <reference types="bun-types" />
// ---------------------------------------------------------------------------
// One-time backfill: re-derive a STRUCTURED address (street/city/region/postcode/
// country) for every production location and write it into the new columns added
// by migration 0008. Replaces the single freeform `address` column, which was
// filled inconsistently across pipelines (street-only chains, full independents,
// mixed `St`/`Street`, `ON`/`Ontario`, spaced/unspaced postcodes, trailing
// country, embedded notes).
//
//   bun run scripts/backfill-address-parts.ts            # dry-run (default): writes a review file, no DB writes
//   bun run scripts/backfill-address-parts.ts --apply    # writes the structured columns to prod D1
//   …--limit 20         # only process the first N locations (for iterating)
//   …--no-network       # skip Nominatim (OSM tags + existing string only) — faster, lower fill
//   …--out <path>       # review file path (default data/address-backfill-review.json)
//
// Derivation, per location, taking the first non-null value for each field from:
//   1. the location's OWN OSM POI `addr:*` tags (local staging store) — authoritative,
//   2. OSM Nominatim — /lookup by the OSM object id (632/695 cite one), else /reverse on
//      the OSM-based coordinates; fills the genuine gaps, especially postcode,
//   3. a conservative parse of the existing `address` string — last-resort backstop.
// Then region → 2-letter code, postcode → canonical spacing, country → ISO-2
// (src/lib/address.ts). Postcode is the only field allowed to stay null.
//
// Nominatim is throttled to ≥1 req/s with a descriptive User-Agent, and every
// response is cached to data/nominatim-cache.json so re-runs cost no requests.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
	composeStreet,
	normalizeCountry,
	normalizePostcode,
	normalizeRegion,
	formatAddress
} from '../src/lib/address';
import { blankToNull } from '../src/lib/text';
import { createHttpD1 } from '../src/lib/server/d1-http';
import type { D1Like } from '../src/lib/server/db';

const STAGING_DB = process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite';
const CACHE_PATH = 'data/nominatim-cache.json';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT =
	'better-food-map/address-backfill (https://betterfoodmaps.com; thuperflee@gmail.com)';

// --- Types -----------------------------------------------------------------

/** Un-normalized address fields gathered from one source (any may be null). */
export interface RawParts {
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
}

/** A reference to an OSM object recovered from a source URL. */
export interface OsmRef {
	osm_type: 'node' | 'way' | 'relation';
	numeric_id: number;
	/** Nominatim /lookup id, e.g. "N123" / "W456" / "R789". */
	lookupId: string;
	/** Staging-store key, e.g. "n123" / "w456" / "r789". */
	storeId: string;
}

/** Nominatim `address` sub-object (only the fields we read). */
export interface NominatimAddress {
	house_number?: string;
	road?: string;
	unit?: string;
	city?: string;
	town?: string;
	village?: string;
	municipality?: string;
	suburb?: string;
	hamlet?: string;
	county?: string;
	state?: string;
	province?: string;
	region?: string;
	/** ISO-3166-2 subdivision code, e.g. "CA-NB" — the authoritative region+country. */
	'ISO3166-2-lvl4'?: string;
	'ISO3166-2-lvl3'?: string;
	'ISO3166-2-lvl6'?: string;
	postcode?: string;
	country?: string;
	country_code?: string;
}

const EMPTY: RawParts = { street: null, city: null, region: null, postcode: null, country: null };

// --- Pure helpers (unit-tested) --------------------------------------------

/**
 * Recovers an OSM object reference from an openstreetmap.org URL such as
 * `https://www.openstreetmap.org/node/123`. Returns null for any other URL.
 */
export function osmRefFromSourceUrl(url: string): OsmRef | null {
	const m = url.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/i);
	if (!m) return null;
	const osm_type = m[1].toLowerCase() as OsmRef['osm_type'];
	const numeric_id = Number(m[2]);
	if (!Number.isFinite(numeric_id)) return null;
	const prefix = osm_type[0]; // n / w / r
	return {
		osm_type,
		numeric_id,
		lookupId: `${prefix.toUpperCase()}${numeric_id}`,
		storeId: `${prefix}${numeric_id}`
	};
}

/** Picks the first OSM source URL from a location's citations, as an OsmRef. */
export function pickOsmRef(urls: string[]): OsmRef | null {
	for (const u of urls) {
		const ref = osmRefFromSourceUrl(u);
		if (ref) return ref;
	}
	return null;
}

/** Structured parts from a POI's own OSM `addr:*` tags. */
export function partsFromOsmTags(tags: Record<string, string>): RawParts {
	const city =
		tags['addr:city'] ??
		tags['addr:town'] ??
		tags['addr:village'] ??
		tags['addr:municipality'] ??
		tags['addr:hamlet'];
	return {
		street: composeStreet(tags['addr:housenumber'], tags['addr:street'], tags['addr:unit']),
		city: blankToNull(city),
		region: blankToNull(tags['addr:state'] ?? tags['addr:province']),
		postcode: blankToNull(tags['addr:postcode']),
		country: blankToNull(tags['addr:country'])
	};
}

/** Structured parts from a Nominatim `address` object. */
export function partsFromNominatim(addr: NominatimAddress): RawParts {
	// Locality, narrowing from real town/city down to the administrative area that
	// holds an unincorporated address (Gasoline Alley / Rocky View County).
	const city =
		addr.city ??
		addr.town ??
		addr.village ??
		addr.municipality ??
		addr.suburb ??
		addr.hamlet ??
		addr.county;

	// The ISO-3166-2 code (e.g. "CA-NB") is the authoritative region — cleaner than
	// the bilingual `state` ("New Brunswick / Nouveau-Brunswick") OSM returns there.
	const iso = addr['ISO3166-2-lvl4'] ?? addr['ISO3166-2-lvl3'] ?? addr['ISO3166-2-lvl6'] ?? null;
	const isoRegion = iso?.includes('-') ? iso.split('-').slice(-1)[0] : null;
	const isoCountry = iso?.includes('-') ? iso.split('-')[0] : null;

	return {
		street: composeStreet(addr.house_number, addr.road, addr.unit),
		city: blankToNull(city),
		region: blankToNull(isoRegion ?? addr.state ?? addr.province ?? addr.region),
		postcode: blankToNull(addr.postcode),
		// Prefer the ISO-2 country_code Nominatim returns (e.g. "ca").
		country: blankToNull(addr.country_code ?? isoCountry ?? addr.country)
	};
}

/**
 * Conservative parse of an existing single-line address, used only as a backstop
 * when tags and Nominatim leave a field empty. Strips parentheticals and a
 * trailing country, then peels the last segment as `REGION postcode` / region /
 * postcode; the first remaining segment is the street, the last is the city.
 */
export function parseAddressLine(line: string | null | undefined): RawParts {
	if (!line) return { ...EMPTY };
	const noParen = line
		.replace(/\([^)]*\)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	let segs = noParen
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	let region: string | null = null;
	let postcode: string | null = null;

	// Drop a trailing country, but never mistake a province/state code (e.g. "BC",
	// which also looks like a 2-letter country code) for one.
	if (
		segs.length &&
		normalizeCountry(segs[segs.length - 1]) &&
		!normalizeRegion(segs[segs.length - 1])
	) {
		segs = segs.slice(0, -1);
	}

	if (segs.length) {
		const last = segs[segs.length - 1];
		const m = last.match(/^(.*?)\s+([A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d)$/); // "BC V6J 1M5"
		if (m) {
			region = m[1].trim();
			postcode = m[2];
			segs = segs.slice(0, -1);
		} else if (normalizePostcode(last)) {
			postcode = last;
			segs = segs.slice(0, -1);
		} else if (normalizeRegion(last)) {
			region = last;
			segs = segs.slice(0, -1);
		}
	}
	if (!region && segs.length > 1 && normalizeRegion(segs[segs.length - 1])) {
		region = segs[segs.length - 1];
		segs = segs.slice(0, -1);
	}

	const street = segs.length ? segs[0] : null;
	const city = segs.length > 1 ? segs[segs.length - 1] : null;
	return {
		street: blankToNull(street),
		city: blankToNull(city),
		region: blankToNull(region),
		postcode: blankToNull(postcode),
		country: null
	};
}

/** Counts leading whole-number tokens, e.g. "8036 118 Ave NW" → 2, "118 Ave" → 1. */
function leadingNumberCount(s: string): number {
	let n = 0;
	for (const tok of s.trim().split(/\s+/)) {
		if (/^\d+[A-Za-z]?$/.test(tok) || /^\d+[A-Za-z]?-\d+[A-Za-z]?$/.test(tok)) n++;
		else break;
	}
	return n;
}

/**
 * Picks the best street from candidates in trust order. Prefers whichever has the
 * MOST leading number tokens — a real address "8036 118 Ave NW" (house # + numbered
 * street = 2) beats a bare "118 Ave NW" (1) or a Nominatim cross-street; ties keep
 * trust order. This is robust on the Prairie grid where the street name itself
 * starts with a number, which a naive "starts-with-a-digit" test gets wrong.
 */
export function chooseStreet(candidates: (string | null)[]): string | null {
	const present = candidates.filter((s): s is string => Boolean(s));
	if (!present.length) return null;
	let best = present[0];
	let bestScore = leadingNumberCount(best);
	for (const c of present.slice(1)) {
		const score = leadingNumberCount(c);
		if (score > bestScore) {
			best = c;
			bestScore = score;
		}
	}
	return best;
}

/** First candidate the validator accepts (e.g. a FULL postcode), else the first non-null. */
function firstUsable(candidates: (string | null)[], ok: (s: string) => boolean): string | null {
	const present = candidates.filter((s): s is string => Boolean(s));
	return present.find(ok) ?? present[0] ?? null;
}

/**
 * Combines the three sources field-by-field with priorities tuned per field:
 *   • street/postcode are the VENUE'S OWN data — the POI's `addr:*` tags, then the
 *     existing string; Nominatim's reverse/lookup only fills a genuine gap, because
 *     it tends to snap to a cross-street or interpolate a neighbouring postcode.
 *   • city/region/country are COARSE administrative areas Nominatim resolves
 *     reliably (ISO region code, correct municipality), so it leads there over the
 *     fragile parse of the old string.
 * region/postcode pick the first candidate that actually normalizes (skipping a
 * bilingual region name or a partial postcode like "E3Y").
 */
export function chooseParts(tags: RawParts, nom: RawParts, existing: RawParts): RawParts {
	return {
		street: chooseStreet([tags.street, existing.street, nom.street]),
		city: tags.city ?? nom.city ?? existing.city,
		region: firstUsable([tags.region, nom.region, existing.region], (r) =>
			Boolean(normalizeRegion(r))
		),
		postcode: firstUsable([tags.postcode, existing.postcode, nom.postcode], (p) =>
			Boolean(normalizePostcode(p))
		),
		country: firstUsable([nom.country, tags.country, existing.country], (c) =>
			Boolean(normalizeCountry(c))
		)
	};
}

export interface NormalizedResult {
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
	/** Required fields (street/city/region/country) still missing after derivation. */
	missingRequired: string[];
	/** True when no usable postcode could be resolved (allowed — postcode is optional). */
	postcodeMissing: boolean;
}

/**
 * Normalizes merged raw parts: country → ISO-2 (inferred from the region code
 * when the source omits it), region → 2-letter code, postcode → canonical form.
 * Reports which required fields remain unresolved.
 */
export function normalizeParts(raw: RawParts): NormalizedResult {
	let country = normalizeCountry(raw.country);
	if (!country && raw.region) {
		if (normalizeRegion(raw.region, 'CA')) country = 'CA';
		else if (normalizeRegion(raw.region, 'US')) country = 'US';
	}

	const street = blankToNull(raw.street);
	const city = blankToNull(raw.city);
	const region = normalizeRegion(raw.region, country);
	const postcode = normalizePostcode(raw.postcode, country);

	const missingRequired: string[] = [];
	if (!street) missingRequired.push('street');
	if (!city) missingRequired.push('city');
	if (!region) missingRequired.push('region');
	if (!country) missingRequired.push('country');

	return { street, city, region, postcode, country, missingRequired, postcodeMissing: !postcode };
}

// --- I/O: staging store, Nominatim, prod D1 --------------------------------

interface LocationRow {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	address: string | null;
}

/** Reads tags_json for a set of staging-store osm ids → parsed tag objects. */
function readStagingTags(storeIds: string[]): Map<string, Record<string, string>> {
	const out = new Map<string, Record<string, string>>();
	if (!storeIds.length || !existsSync(STAGING_DB)) return out;
	const db = new Database(STAGING_DB, { readonly: true });
	try {
		// Chunk the IN-list to keep the SQL bound-variable count sane.
		for (let i = 0; i < storeIds.length; i += 500) {
			const chunk = storeIds.slice(i, i + 500);
			const placeholders = chunk.map(() => '?').join(',');
			const rows = db
				.query(`SELECT osm_id, tags_json FROM osm_poi WHERE osm_id IN (${placeholders})`)
				.all(...chunk) as { osm_id: string; tags_json: string }[];
			for (const r of rows) {
				try {
					out.set(r.osm_id, JSON.parse(r.tags_json) as Record<string, string>);
				} catch {
					/* skip corrupt tags */
				}
			}
		}
	} finally {
		db.close();
	}
	return out;
}

/** A tiny on-disk cache of Nominatim responses, keyed by lookup/reverse query. */
class NominatimCache {
	private map: Record<string, NominatimAddress | null>;
	constructor(private path: string) {
		this.map = existsSync(path)
			? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, NominatimAddress | null>)
			: {};
	}
	get(key: string): NominatimAddress | null | undefined {
		return key in this.map ? this.map[key] : undefined;
	}
	set(key: string, value: NominatimAddress | null): void {
		this.map[key] = value;
		writeFileSync(this.path, JSON.stringify(this.map));
	}
	get size(): number {
		return Object.keys(this.map).length;
	}
}

/** Nominatim client: throttled, cached, OSM-attributed. */
class Nominatim {
	private lastCall = 0;
	constructor(private cache: NominatimCache) {}

	private async throttle(): Promise<void> {
		const since = Date.now() - this.lastCall;
		if (since < 1100) await Bun.sleep(1100 - since);
		this.lastCall = Date.now();
	}

	private async fetchJson(url: string): Promise<unknown> {
		await this.throttle();
		const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (!res.ok) throw new Error(`Nominatim ${res.status} for ${url}`);
		return res.json();
	}

	/** Reverse-geocodes a coordinate to its address (cached). */
	async reverse(lat: number, lon: number): Promise<NominatimAddress | null> {
		const key = `reverse:${lat.toFixed(6)},${lon.toFixed(6)}`;
		const hit = this.cache.get(key);
		if (hit !== undefined) return hit;
		const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1`;
		const json = (await this.fetchJson(url)) as { address?: NominatimAddress };
		const addr = json?.address ?? null;
		this.cache.set(key, addr);
		return addr;
	}

	/** Looks up a batch of OSM objects by id (≤50), filling the cache per object. */
	async lookup(refs: OsmRef[]): Promise<void> {
		const need = refs.filter((r) => this.cache.get(`lookup:${r.lookupId}`) === undefined);
		for (let i = 0; i < need.length; i += 50) {
			const chunk = need.slice(i, i + 50);
			const ids = chunk.map((r) => r.lookupId).join(',');
			const url = `${NOMINATIM_BASE}/lookup?osm_ids=${ids}&format=jsonv2&addressdetails=1`;
			const arr = (await this.fetchJson(url)) as {
				osm_type?: string;
				osm_id?: number;
				address?: NominatimAddress;
			}[];
			const byKey = new Map<string, NominatimAddress>();
			for (const o of arr ?? []) {
				if (o.osm_type && o.osm_id !== undefined) {
					byKey.set(`${o.osm_type[0].toUpperCase()}${o.osm_id}`, o.address ?? {});
				}
			}
			// Cache every requested ref (null when Nominatim returned nothing for it).
			for (const r of chunk) this.cache.set(`lookup:${r.lookupId}`, byKey.get(r.lookupId) ?? null);
		}
	}

	lookupCached(ref: OsmRef): NominatimAddress | null {
		return this.cache.get(`lookup:${ref.lookupId}`) ?? null;
	}
}

// --- Orchestration ---------------------------------------------------------

interface ReviewRow {
	id: string;
	name: string;
	old_address: string | null;
	new_address: string | null;
	street: string | null;
	city: string | null;
	region: string | null;
	postcode: string | null;
	country: string | null;
	sources: { osm_tags: boolean; nominatim: boolean; existing: boolean };
	missing_required: string[];
	postcode_missing: boolean;
}

interface Args {
	apply: boolean;
	network: boolean;
	limit: number | null;
	out: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		network: true,
		limit: null,
		out: 'data/address-backfill-review.json'
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--apply') args.apply = true;
		else if (a === '--dry-run') args.apply = false;
		else if (a === '--no-network') args.network = false;
		else if (a === '--limit') args.limit = Number(argv[++i]);
		else if (a === '--out') args.out = argv[++i];
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const db: D1Like = createHttpD1();

	console.error('→ reading locations from prod D1 (read-only)…');
	const { results: locs } = await db
		.prepare('SELECT id, name, latitude, longitude, address FROM locations ORDER BY name')
		.all<LocationRow>();
	const locations = args.limit ? locs.slice(0, args.limit) : locs;

	const { results: srcRows } = await db
		.prepare("SELECT location_id, url FROM location_sources WHERE url LIKE '%openstreetmap.org/%'")
		.all<{ location_id: string; url: string }>();
	const osmUrlByLoc = new Map<string, string[]>();
	for (const r of srcRows) {
		const list = osmUrlByLoc.get(r.location_id) ?? [];
		list.push(r.url);
		osmUrlByLoc.set(r.location_id, list);
	}

	// Recover OSM refs and load their POI tags from the local staging store.
	const refByLoc = new Map<string, OsmRef>();
	for (const loc of locations) {
		const ref = pickOsmRef(osmUrlByLoc.get(loc.id) ?? []);
		if (ref) refByLoc.set(loc.id, ref);
	}
	const tagsByStoreId = readStagingTags([...new Set([...refByLoc.values()].map((r) => r.storeId))]);
	console.error(
		`  ${locations.length} locations; ${refByLoc.size} with an OSM ref; ` +
			`${tagsByStoreId.size} found in the staging store.`
	);

	// Nominatim: batch-lookup the OSM-referenced ones, reverse-geocode the rest.
	const cache = new NominatimCache(CACHE_PATH);
	const nom = new Nominatim(cache);
	if (args.network) {
		console.error('→ querying OSM Nominatim (throttled ≥1 req/s, cached)…');
		await nom.lookup([...refByLoc.values()]);
		let n = 0;
		for (const loc of locations) {
			if (!refByLoc.has(loc.id)) {
				await nom.reverse(loc.latitude, loc.longitude);
				if (++n % 10 === 0) console.error(`  reverse-geocoded ${n}…`);
			}
		}
		console.error(`  Nominatim cache holds ${cache.size} entries.`);
	}

	// Derive structured parts per location.
	const review: ReviewRow[] = [];
	for (const loc of locations) {
		const ref = refByLoc.get(loc.id);
		const tags = ref ? tagsByStoreId.get(ref.storeId) : undefined;
		const tagParts = tags ? partsFromOsmTags(tags) : { ...EMPTY };

		let nomParts: RawParts = { ...EMPTY };
		if (args.network) {
			const addr = ref ? nom.lookupCached(ref) : await nom.reverse(loc.latitude, loc.longitude);
			if (addr) nomParts = partsFromNominatim(addr);
		}
		const existingParts = parseAddressLine(loc.address);

		const merged = chooseParts(tagParts, nomParts, existingParts);
		const norm = normalizeParts(merged);
		const newAddress =
			norm.street && norm.city && norm.region
				? formatAddress({
						street: norm.street,
						city: norm.city,
						region: norm.region,
						postcode: norm.postcode
					})
				: null;

		review.push({
			id: loc.id,
			name: loc.name,
			old_address: loc.address,
			new_address: newAddress,
			street: norm.street,
			city: norm.city,
			region: norm.region,
			postcode: norm.postcode,
			country: norm.country,
			sources: {
				osm_tags: Boolean(tags),
				nominatim: args.network && (ref ? Boolean(nom.lookupCached(ref)) : true),
				existing: Boolean(loc.address)
			},
			missing_required: norm.missingRequired,
			postcode_missing: norm.postcodeMissing
		});
	}

	// Summary.
	const complete = review.filter((r) => r.missing_required.length === 0);
	const hard = review.filter((r) => r.missing_required.length > 0);
	const noPostcode = complete.filter((r) => r.postcode_missing);
	console.error('\n=== Backfill summary ===');
	console.error(`locations processed : ${review.length}`);
	console.error(`fully resolved      : ${complete.length}`);
	console.error(`postcode null       : ${noPostcode.length} (allowed)`);
	console.error(`MISSING required    : ${hard.length}`);
	for (const r of hard.slice(0, 40)) {
		console.error(`  [${r.missing_required.join('+')}] ${r.name} — ${r.old_address ?? '(none)'}`);
	}
	if (hard.length > 40) console.error(`  …and ${hard.length - 40} more`);

	writeFileSync(args.out, JSON.stringify(review, null, 2));
	console.error(`\nReview file written: ${args.out}`);

	if (!args.apply) {
		console.error('Dry run — no DB writes. Re-run with --apply to write the structured columns.');
		return;
	}

	// Apply: write structured columns for every fully-resolved location.
	console.error(`\n→ applying ${complete.length} updates to prod D1…`);
	const stmts = complete.map((r) =>
		db
			.prepare(
				'UPDATE locations SET street = ?, city = ?, region = ?, postcode = ?, country = ? WHERE id = ?'
			)
			.bind(r.street, r.city, r.region, r.postcode, r.country, r.id)
	);
	// Batch in chunks so one request isn't unboundedly large.
	for (let i = 0; i < stmts.length; i += 100) {
		await db.batch(stmts.slice(i, i + 100));
		console.error(`  wrote ${Math.min(i + 100, stmts.length)}/${stmts.length}`);
	}
	console.error(
		`Done. ${complete.length} updated; ${hard.length} left for manual fixing (see review file).`
	);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
