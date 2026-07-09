// Client-safe helpers for the geographic browse pages (src/routes/[country]/…,
// the crawlable index tree of #217) and their param matchers. Pure — no server
// imports — so the routes, the components, the `geo`/`diet` param matchers (which
// run on both server and client) and any test all mint identical paths and
// resolve identical diet slugs. Country/region live in the URL as lower-cased
// 2-letter codes (`/ca/on`), cities and diets as slugs (`/ca/on/toronto/vegan`).
import { TAGS, type Tag } from './tags';
import { slugify } from './text';

/** The browse tree's root: the countries index, linked from the landing footer. */
export const PLACES_PATH = '/places';

/** The six dietary tags, in canonical display order (see {@link TAGS}). The
 *  browse tree's per-diet pages exist for exactly these. */
export const DIETARY_TAGS: readonly Tag[] = TAGS.filter((t) => t.tag_type === 'dietary');

/**
 * A dietary tag id as a URL slug: underscores become hyphens so the path reads
 * `…/gluten-free`, not `…/gluten_free`. The inverse of {@link dietTagIdFromSlug}.
 */
export function dietSlug(tagId: string): string {
	return tagId.replace(/_/g, '-');
}

/**
 * The dietary tag id a URL slug names, or null when the slug isn't one of the
 * six dietary tags. Backs the `diet` param matcher (so only real diet pages
 * route) and the diet page's load (slug → tag id).
 */
export function dietTagIdFromSlug(slug: string): string | null {
	const id = slug.replace(/-/g, '_');
	return DIETARY_TAGS.some((t) => t.id === id) ? id : null;
}

/** The city portion of a browse URL: the city name, slugified (`North York` →
 *  `north-york`). Reversed at load time by matching against the region's real
 *  city names (the slug is lossy), so it lives here as the ONE definition both
 *  sides share. */
export function citySlug(city: string): string {
	return slugify(city);
}

/**
 * Collapse city rows that slugify to the same URL slug into one row per slug.
 * Distinct raw spellings of a city ("Grand Forks" vs "GRAND FORKS", "Fort St
 * John" vs "Fort St. John") share a single city page — its load matches the slug
 * against every spelling and lists their venues together (see the [city] route).
 * So the region index must surface ONE link for them: two rows would emit two
 * `<a>`s with the same `cityPath` href and, keyed by href, crash the browse
 * list's `{#each}` with `each_key_duplicate`. Input is expected ordered by count
 * desc (as {@link getBrowseCities} returns it), so the first spelling seen — the
 * most-covered — names the merged row, mirroring the city page's own choice of
 * display name; counts sum. Insertion order is preserved.
 */
export function mergeCitiesBySlug<T extends { value: string; count: number }>(
	cities: readonly T[]
): { value: string; count: number }[] {
	const bySlug = new Map<string, { value: string; count: number }>();
	for (const c of cities) {
		const slug = citySlug(c.value);
		const merged = bySlug.get(slug);
		if (merged) merged.count += c.count;
		else bySlug.set(slug, { value: c.value, count: c.count });
	}
	return [...bySlug.values()];
}

/** `/ca` — a country index. `country` is the stored ISO-2 code. */
export function countryPath(country: string): string {
	return `/${country.toLowerCase()}`;
}

/** `/ca/on` — a region (province/state) index. */
export function regionPath(country: string, region: string): string {
	return `/${country.toLowerCase()}/${region.toLowerCase()}`;
}

/** `/ca/on/toronto` — a city's venue list. */
export function cityPath(country: string, region: string, city: string): string {
	return `${regionPath(country, region)}/${citySlug(city)}`;
}

/** `/ca/on/toronto/vegan` — a city's venues filtered to one diet. */
export function dietCityPath(country: string, region: string, city: string, tagId: string): string {
	return `${cityPath(country, region, city)}/${dietSlug(tagId)}`;
}
