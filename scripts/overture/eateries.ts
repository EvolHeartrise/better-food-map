// ---------------------------------------------------------------------------
// Shared Overture-eatery primitives: the NDJSON row shape written by
// fetch-canada-eateries.py, Canadian-province resolution, category → staging-
// class bucketing, and NDJSON streaming, shared so every Overture consumer
// (e.g. the leads builder, build-leads.ts) uses the SAME parsing/bucketing and
// can never drift.
// ---------------------------------------------------------------------------

/** The Overture Places release the local NDJSON/DuckDB caches were fetched from. */
export const OVERTURE_RELEASE = '2026-06-17.0';

/** One NDJSON row as written by scripts/overture/fetch-canada-eateries.py. */
export interface OvertureEateryRow {
	id: string;
	name: string | null;
	category: string;
	hierarchy: string[] | null;
	confidence: number | null;
	operating_status: string | null;
	brand_wikidata: string | null;
	brand_name: string | null;
	lon: number;
	lat: number;
	freeform: string | null;
	locality: string | null;
	addr_region: string | null;
	postcode: string | null;
	country: string | null;
	website: string | null;
	phone: string | null;
	social: string | null;
	datasets: string[] | null;
	/** Province name from the point-in-polygon join (null = US spillover / offshore). */
	province: string | null;
}

/** PIP province name (canada-provinces.geojson) → 2-letter code. */
export const PROV_CODE: Record<string, string> = {
	Quebec: 'QC',
	'Newfoundland and Labrador': 'NL',
	'British Columbia': 'BC',
	Nunavut: 'NU',
	'Northwest Territories': 'NT',
	'New Brunswick': 'NB',
	'Nova Scotia': 'NS',
	Saskatchewan: 'SK',
	Alberta: 'AB',
	'Prince Edward Island': 'PE',
	'Yukon Territory': 'YT',
	Manitoba: 'MB',
	Ontario: 'ON'
};
const CA_CODES = new Set(Object.values(PROV_CODE));

/**
 * Resolves a row's Canadian province code: the point-in-polygon province first,
 * else a CA-coded address region on a row not explicitly marked US (CA province
 * and US state codes are disjoint). Null = not a Canadian row (US spillover /
 * offshore) — drop it. `from_address` reports which path resolved, so callers
 * can count the fallback's contribution.
 */
export function resolveProvince(
	row: Pick<OvertureEateryRow, 'province' | 'addr_region' | 'country'>
): { code: string; from_address: boolean } | null {
	const pip = row.province ? PROV_CODE[row.province] : null;
	if (pip) return { code: pip, from_address: false };
	const ar = row.addr_region?.toUpperCase().replace(/\./g, '') ?? null;
	if (ar && CA_CODES.has(ar) && row.country !== 'US') return { code: ar, from_address: true };
	return null;
}

// Buckets follow the release's NEW taxonomy (food_and_drink > restaurant /
// casual_eatery / alcoholic_beverage_venue / non_alcoholic_beverage_venue),
// with category-set overrides so the buckets mirror the OSM staging classes.
const OV_FAST = new Set([
	'fast_food_restaurant',
	'sandwich_shop',
	'food_stand',
	'food_truck',
	'friterie',
	'street_vendor'
]);
const OV_BAKERY = new Set(['bakery', 'flatbread', 'back_shop', 'bagel_shop', 'pretzels']);
const OV_DESSERT = new Set([
	'candy_store',
	'japanese_confectionery_shop',
	'chocolatier',
	'pie_shop',
	'patisserie_cake_shop',
	'chimney_cake_shop',
	'cupcake_shop',
	'custom_cakes_shop',
	'desserts',
	'donuts',
	'ice_cream_and_frozen_yoghurt',
	'gelato',
	'ice_cream_shop',
	'frozen_yoghurt_shop',
	'shaved_ice_shop',
	'shaved_snow_shop'
]);

/** Maps an Overture category (+ taxonomy hierarchy) onto the OSM staging-class buckets. */
export function ovBucket(category: string, hierarchy: string[] | null): string {
	if (category === 'food_court') return 'food_court';
	if (OV_FAST.has(category)) return 'fast_food';
	if (OV_BAKERY.has(category)) return 'bakery';
	if (OV_DESSERT.has(category) || hierarchy?.includes('dessert_shop')) return 'dessert';
	const h2 = hierarchy?.[1];
	if (h2 === 'alcoholic_beverage_venue') return 'bar_pub';
	if (h2 === 'non_alcoholic_beverage_venue' || category === 'cafe' || category === 'internet_cafe')
		return 'cafe';
	if (h2 === 'restaurant' || h2 === 'casual_eatery') return 'restaurant';
	return 'other';
}

/**
 * The first non-Overture entry of a row's source `datasets` (e.g. "meta",
 * "microsoft"), or "Overture" when the row is Overture-native. "Overture-signals"
 * is bookkeeping, not a source.
 */
export function primaryDataset(datasets: string[] | null): string {
	return (datasets ?? []).find((x) => x !== 'Overture' && x !== 'Overture-signals') ?? 'Overture';
}

/** Options for {@link streamNdjson} (both default off, i.e. strict NDJSON). */
export interface StreamNdjsonOptions {
	/** Also accept a whole top-level JSON array (small hand-made caches). */
	acceptArray?: boolean;
	/** Skip lines that fail to parse instead of throwing on them. */
	skipMalformed?: boolean;
}

/**
 * Streams JSON rows from an NDJSON file without materializing it (blank lines
 * skipped). By default a malformed line THROWS — right for diff/lead tools where
 * silently under-reading a snapshot would fabricate results. `skipMalformed`
 * tolerates junk lines and `acceptArray` also handles a single top-level JSON
 * array (see overture-enrich.ts, the address/contacts caches).
 */
export async function* streamNdjson<T>(
	path: string,
	options: StreamNdjsonOptions = {}
): AsyncGenerator<T> {
	const { acceptArray = false, skipMalformed = false } = options;
	if (acceptArray) {
		const head = await Bun.file(path).slice(0, 1).text();
		if (head.trimStart().startsWith('[')) {
			yield* JSON.parse(await Bun.file(path).text()) as T[];
			return;
		}
	}
	const parseLine = function* (line: string): Generator<T> {
		if (!line.trim()) return;
		if (!skipMalformed) {
			yield JSON.parse(line) as T;
			return;
		}
		try {
			yield JSON.parse(line) as T;
		} catch {
			// skip malformed line
		}
	};
	const decoder = new TextDecoder();
	let buf = '';
	for await (const chunk of Bun.file(path).stream()) {
		buf += decoder.decode(chunk, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop() ?? '';
		for (const line of lines) yield* parseLine(line);
	}
	buf += decoder.decode(); // flush any trailing multibyte remainder
	yield* parseLine(buf);
}
