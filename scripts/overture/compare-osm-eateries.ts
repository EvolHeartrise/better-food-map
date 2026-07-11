// Overture-vs-OSM eatery comparison (issue #302 experiment).
// Reads data/osm-poi.sqlite + data/overture-canada-eateries.ndjson (built by
// scripts/overture/fetch-canada-eateries.py), matches the two sets
// (name-related + nearest within 500 m, same primitives as match-overture.ts),
// and writes data/overture-osm-comparison.json: per-province counts, category
// mix, completeness, confidence tiers, source datasets, and match distances.
// Run: bun scripts/overture/compare-osm-eateries.ts
import { Database } from 'bun:sqlite';
import { bboxAround, haversineMeters, SpatialGrid } from '../osm/geo';
import { normalizeName } from '../osm/search-poi';
import {
	OVERTURE_RELEASE,
	ovBucket,
	primaryDataset,
	resolveProvince,
	streamNdjson,
	type OvertureEateryRow
} from './eateries';
import { nameRelated } from './match-overture';

const ROOT = `${import.meta.dir}/../..`;
const OUT = `${ROOT}/data/overture-osm-comparison.json`;
const RADIUS_M = 500;
const CELL_DEG = 0.005;

// Province resolution + Overture category buckets live in ./eateries (shared
// with the leads builder, scripts/overture/build-leads.ts).
const OSM_BUCKET: Record<string, string> = {
	restaurant: 'restaurant',
	fast_food: 'fast_food',
	cafe: 'cafe',
	pub: 'bar_pub',
	bar: 'bar_pub',
	biergarten: 'bar_pub',
	bakery: 'bakery',
	ice_cream: 'dessert',
	confectionery: 'dessert',
	pastry: 'dessert',
	food_court: 'food_court'
};

// ---- load OSM staging POIs ----
const db = new Database(`${ROOT}/data/osm-poi.sqlite`, { readonly: true });
type Poi = {
	osm_id: string;
	name: string | null;
	normalized_name: string | null;
	osm_class: string;
	latitude: number;
	longitude: number;
	admin_region: string | null;
	address: string | null;
	phone: string | null;
	website: string | null;
	opening_hours: string | null;
	cuisine: string | null;
	tags_json: string;
};
const pois = db
	.query<Poi, []>(
		`SELECT osm_id, name, normalized_name, osm_class, latitude, longitude, admin_region,
	        address, phone, website, opening_hours, cuisine, tags_json FROM osm_poi`
	)
	.all();

const grid = new SpatialGrid(CELL_DEG);
pois.forEach((p, i) => grid.insert(i, p.latitude, p.longitude));

// ---- stream Overture eateries, bucket, match ----
type Agg = {
	count: number;
	conf_sum: number;
	conf50: number;
	conf75: number;
	conf85: number;
	conf95: number;
	street: number;
	postcode: number;
	phone: number;
	website: number;
	matched: number;
	brand: number;
	closed: number;
};
const newAgg = (): Agg => ({
	count: 0,
	conf_sum: 0,
	conf50: 0,
	conf75: 0,
	conf85: 0,
	conf95: 0,
	street: 0,
	postcode: 0,
	phone: 0,
	website: 0,
	matched: 0,
	brand: 0,
	closed: 0
});

const ovByProv = new Map<string, Agg>();
const ovBucketCounts = new Map<string, number>();
const ovBucketByProv = new Map<string, Map<string, number>>();
const ovCategoryCounts = new Map<string, number>();
const opStatus = new Map<string, number>();
const datasetCounts = new Map<string, number>();
const confHist = new Array(20).fill(0);
const matchDistances: number[] = [];
const matchDistByProv = new Map<string, number[]>();
const matchedPois = new Map<number, number>(); // poi idx -> best distance
const ovUnmatchedNames = new Map<string, number>(); // high-confidence Overture-only names
const ovUnmatchedByProvHi = new Map<string, number>(); // conf>=0.85 unmatched per prov
const ovHiByProv = new Map<string, number>(); // conf>=0.85 total per prov
let dropped = 0,
	total = 0,
	provFromAddr = 0;
const confByMatch = { matched: new Array(20).fill(0), unmatched: new Array(20).fill(0) };
const datasetByMatch = new Map<string, { matched: number; unmatched: number }>();

for await (const r of streamNdjson<OvertureEateryRow>(
	`${ROOT}/data/overture-canada-eateries.ndjson`
)) {
	total++;
	// province: PIP first, else CA-coded address region, else drop (US spillover / offshore)
	const resolved = resolveProvince(r);
	if (!resolved) {
		dropped++;
		continue;
	}
	if (resolved.from_address) provFromAddr++;
	const prov = resolved.code;

	const bucket = ovBucket(r.category, r.hierarchy);
	ovCategoryCounts.set(r.category, (ovCategoryCounts.get(r.category) ?? 0) + 1);
	ovBucketCounts.set(bucket, (ovBucketCounts.get(bucket) ?? 0) + 1);
	let bp = ovBucketByProv.get(prov);
	if (!bp) ovBucketByProv.set(prov, (bp = new Map()));
	bp.set(bucket, (bp.get(bucket) ?? 0) + 1);

	const a = ovByProv.get(prov) ?? (ovByProv.set(prov, newAgg()), ovByProv.get(prov)!);
	a.count++;
	const c = r.confidence ?? 0;
	a.conf_sum += c;
	if (c >= 0.5) a.conf50++;
	if (c >= 0.75) a.conf75++;
	if (c >= 0.85) {
		a.conf85++;
		ovHiByProv.set(prov, (ovHiByProv.get(prov) ?? 0) + 1);
	}
	if (c >= 0.95) a.conf95++;
	confHist[Math.min(19, Math.floor(c * 20))]++;
	if (r.freeform) a.street++;
	if (r.postcode) a.postcode++;
	if (r.phone) a.phone++;
	if (r.website) a.website++;
	if (r.brand_wikidata || r.brand_name) a.brand++;
	if (r.operating_status && r.operating_status !== 'open') a.closed++;
	opStatus.set(r.operating_status ?? 'null', (opStatus.get(r.operating_status ?? 'null') ?? 0) + 1);
	for (const d of r.datasets ?? []) datasetCounts.set(d, (datasetCounts.get(d) ?? 0) + 1);

	// match to nearest name-related OSM POI within RADIUS_M
	const ovName = normalizeName(r.name);
	let bestIdx = -1,
		bestDist = Infinity;
	if (ovName) {
		const box = bboxAround(r.lat, r.lon, RADIUS_M / 1000);
		for (const idx of grid.candidatesInBbox(box)) {
			const p = pois[idx];
			if (!nameRelated(p.normalized_name ?? normalizeName(p.name), ovName)) continue;
			const d = haversineMeters(p.latitude, p.longitude, r.lat, r.lon);
			if (d <= RADIUS_M && d < bestDist) {
				bestDist = d;
				bestIdx = idx;
			}
		}
	}
	const mk = bestIdx >= 0 ? 'matched' : 'unmatched';
	confByMatch[mk][Math.min(19, Math.floor(c * 20))]++;
	const primaryDs = primaryDataset(r.datasets);
	const dm =
		datasetByMatch.get(primaryDs) ??
		(datasetByMatch.set(primaryDs, { matched: 0, unmatched: 0 }), datasetByMatch.get(primaryDs)!);
	dm[mk]++;
	if (bestIdx >= 0) {
		a.matched++;
		matchDistances.push(bestDist);
		let mdp = matchDistByProv.get(prov);
		if (!mdp) matchDistByProv.set(prov, (mdp = []));
		mdp.push(bestDist);
		const prev = matchedPois.get(bestIdx);
		if (prev === undefined || bestDist < prev) matchedPois.set(bestIdx, bestDist);
	} else if (c >= 0.85) {
		ovUnmatchedByProvHi.set(prov, (ovUnmatchedByProvHi.get(prov) ?? 0) + 1);
		const key = (r.brand_name ?? r.name ?? '??').trim();
		ovUnmatchedNames.set(key, (ovUnmatchedNames.get(key) ?? 0) + 1);
	}
}

// ---- OSM aggregates ----
type OsmAgg = {
	count: number;
	street: number;
	phone: number;
	website: number;
	hours: number;
	cuisine: number;
	matched: number;
};
const osmByProv = new Map<string, OsmAgg>();
const osmBucketByProv = new Map<string, Map<string, number>>();
const osmBucketCounts = new Map<string, number>();
pois.forEach((p, i) => {
	const prov = p.admin_region ?? 'unknown';
	const a =
		osmByProv.get(prov) ??
		(osmByProv.set(prov, {
			count: 0,
			street: 0,
			phone: 0,
			website: 0,
			hours: 0,
			cuisine: 0,
			matched: 0
		}),
		osmByProv.get(prov)!);
	a.count++;
	if (p.address) a.street++;
	if (p.phone) a.phone++;
	if (p.website) a.website++;
	if (p.opening_hours) a.hours++;
	if (p.cuisine) a.cuisine++;
	if (matchedPois.has(i)) a.matched++;
	const b = OSM_BUCKET[p.osm_class] ?? 'other';
	osmBucketCounts.set(b, (osmBucketCounts.get(b) ?? 0) + 1);
	let bp = osmBucketByProv.get(prov);
	if (!bp) osmBucketByProv.set(prov, (bp = new Map()));
	bp.set(b, (bp.get(b) ?? 0) + 1);
});

const pct = (arr: number[], q: number) => {
	if (!arr.length) return null;
	const s = [...arr].toSorted((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const distStats = (arr: number[]) => ({
	n: arr.length,
	p50: pct(arr, 0.5),
	p75: pct(arr, 0.75),
	p90: pct(arr, 0.9),
	p95: pct(arr, 0.95),
	under25: arr.filter((d) => d <= 25).length,
	under50: arr.filter((d) => d <= 50).length,
	under100: arr.filter((d) => d <= 100).length,
	under250: arr.filter((d) => d <= 250).length
});

const out = {
	meta: {
		release: OVERTURE_RELEASE,
		radius_m: RADIUS_M,
		overture_bbox_rows: total,
		overture_dropped_non_canada: dropped,
		province_from_address_fallback: provFromAddr,
		osm_pois: pois.length
	},
	by_province: Object.fromEntries(
		[...new Set([...ovByProv.keys(), ...osmByProv.keys()])].toSorted().map((prov) => {
			const ov = ovByProv.get(prov),
				osm = osmByProv.get(prov);
			return [
				prov,
				{
					osm: osm ?? null,
					overture: ov
						? { ...ov, conf_mean: +(ov.conf_sum / ov.count).toFixed(3), conf_sum: undefined }
						: null,
					overture_hi_conf_unmatched: ovUnmatchedByProvHi.get(prov) ?? 0,
					overture_hi_conf_total: ovHiByProv.get(prov) ?? 0,
					match_dist: distStats(matchDistByProv.get(prov) ?? [])
				}
			];
		})
	),
	buckets: {
		osm: Object.fromEntries([...osmBucketCounts.entries()].toSorted((a, b) => b[1] - a[1])),
		overture: Object.fromEntries([...ovBucketCounts.entries()].toSorted((a, b) => b[1] - a[1]))
	},
	buckets_by_province: Object.fromEntries(
		[...new Set([...ovBucketByProv.keys(), ...osmBucketByProv.keys()])].toSorted().map((prov) => [
			prov,
			{
				osm: Object.fromEntries(osmBucketByProv.get(prov) ?? []),
				overture: Object.fromEntries(ovBucketByProv.get(prov) ?? [])
			}
		])
	),
	overture_categories_top40: Object.fromEntries(
		[...ovCategoryCounts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 40)
	),
	operating_status: Object.fromEntries(opStatus),
	source_datasets: Object.fromEntries([...datasetCounts.entries()].toSorted((a, b) => b[1] - a[1])),
	confidence_histogram_5pct_bins: confHist,
	confidence_by_match: confByMatch,
	dataset_by_match: Object.fromEntries(
		[...datasetByMatch.entries()].toSorted(
			(a, b) => b[1].matched + b[1].unmatched - a[1].matched - a[1].unmatched
		)
	),
	osm_brand_tagged: pois.filter((p) => p.tags_json?.includes('"brand"')).length,
	match: {
		overture_matched: matchDistances.length,
		osm_pois_matched: matchedPois.size,
		dist: distStats(matchDistances)
	},
	top_unmatched_hi_conf_names: Object.fromEntries(
		[...ovUnmatchedNames.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 60)
	)
};

await Bun.write(`${OUT}`, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}`);
console.log(
	'overture rows kept:',
	total - dropped,
	'of',
	total,
	`(+${provFromAddr} via address fallback)`
);
console.log(
	'matched overture→osm:',
	matchDistances.length,
	'| distinct OSM POIs matched:',
	matchedPois.size
);
