/**
 * schema.org JSON-LD structured data for a venue's document head (issue #218).
 *
 * A hard `/locations/<id>` load already server-renders the venue's `<title>`,
 * meta description and canonical link (see $lib/venue-head); this adds the
 * machine-readable twin crawlers actually parse for rich results — a
 * FoodEstablishment object with the venue's address, coordinates and full menu
 * (names, descriptions, prices and per-item diet suitability). Emitted from the
 * same `{#if headMeta}` head branch in src/routes/+page.svelte.
 *
 * Pure and client-safe (no server/runtime deps) so scripts/venue-jsonld.test.ts
 * can pin the emitted graph without mounting the page. The venue fields map 1:1
 * onto schema.org: this map has menu data cleaner than almost any site marks up,
 * so the point is to expose it losslessly and let Google's Rich Results Test
 * validate it.
 */

import type { Category } from './category';
import { impliedDietTagIds, type TagId } from './tags';
import { locationPath } from './location-path';
import { CANONICAL_ORIGIN } from './canonical';
import { formatPhone } from './phone';

/** The item fields the menu graph reads — the full detail shape (#83), not the lean map item. */
export interface JsonLdItem {
	item_name: string;
	description: string | null;
	price: number | null;
	/** Upper-case ISO-4217 code `price` is denominated in (e.g. "CAD"). */
	currency: string;
	/** Dietary + course tag edges, each with its per-edge `optional` flag. */
	tags: ReadonlyArray<{ id: string; optional: boolean }>;
}

/** The venue fields the structured-data graph reads (a superset of the head-meta shape). */
export interface JsonLdVenue {
	id: string;
	name: string;
	category: Category | null;
	/** Exact OSM coordinates — emitted verbatim (schema.org geo). */
	latitude: number;
	longitude: number;
	/** Structured address parts (never a freeform line — see the data policy). */
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
	phone: string | null;
	/** The venue's own website, surfaced as `sameAs` (our page is the `url`). */
	website: string | null;
	menu: ReadonlyArray<JsonLdItem>;
}

/**
 * Each category maps to the most specific schema.org FoodEstablishment subtype,
 * so the object carries the venue kind in its `@type` rather than a fabricated
 * `servesCuisine` (we hold no cuisine data). An unset category falls back to the
 * base FoodEstablishment.
 */
const SCHEMA_TYPE_BY_CATEGORY: Record<Category, string> = {
	cafe: 'CafeOrCoffeeShop',
	fast_food: 'FastFoodRestaurant',
	restaurant: 'Restaurant',
	bakery: 'Bakery'
};

/**
 * Our six dietary tags mapped to schema.org RestrictedDiet members. Five map
 * cleanly; `dairy_free` takes LowLactoseDiet (schema.org's closest member, as
 * the issue notes) and `nut_free` has NO RestrictedDiet equivalent, so a
 * nut-free-only item simply carries no `suitableForDiet` rather than an invented
 * value. Keyed in display order so the emitted list is deterministic.
 */
const DIET_SCHEMA_TYPE: Partial<Record<TagId, string>> = {
	vegan: 'VeganDiet',
	vegetarian: 'VegetarianDiet',
	halal: 'HalalDiet',
	gluten_free: 'GlutenFreeDiet',
	dairy_free: 'LowLactoseDiet'
};

/** The mappable diets in emission order (the keys of {@link DIET_SCHEMA_TYPE}). */
const DIET_ORDER = Object.keys(DIET_SCHEMA_TYPE) as TagId[];

/**
 * The `suitableForDiet` URLs for one item: its explicitly-asserted, non-optional
 * dietary tags, EXPANDED through the vegan -> vegetarian/dairy-free implication
 * closure (impliedDietTagIds). This mirrors the map's diet FILTER, which surfaces
 * a vegan item under the Vegetarian selector — so a diet-search crawler sees the
 * same suitability the app's own filter grants. Optional ("can be made vegan")
 * tags never assert a diet, matching the source-asserted data policy.
 */
function itemDietUrls(tags: JsonLdItem['tags']): string[] {
	const ids = new Set<string>();
	for (const tag of tags) {
		if (!tag.optional && DIET_SCHEMA_TYPE[tag.id as TagId]) ids.add(tag.id);
	}
	for (const id of impliedDietTagIds(tags)) {
		if (DIET_SCHEMA_TYPE[id as TagId]) ids.add(id);
	}
	return DIET_ORDER.filter((id) => ids.has(id)).map(
		(id) => `https://schema.org/${DIET_SCHEMA_TYPE[id]}`
	);
}

/** One schema.org MenuItem node — name, optional description, price offer and diet suitability. */
function menuItemNode(item: JsonLdItem): Record<string, unknown> {
	const node: Record<string, unknown> = { '@type': 'MenuItem', name: item.item_name };
	if (item.description) node.description = item.description;
	// price !== null (not truthiness): a $0 item still carries a valid offer.
	if (item.price !== null) {
		node.offers = { '@type': 'Offer', price: item.price, priceCurrency: item.currency };
	}
	const diets = itemDietUrls(item.tags);
	if (diets.length > 0) node.suitableForDiet = diets;
	return node;
}

/** The venue's PostalAddress node — structured parts 1:1, empty parts and a missing postcode dropped. */
function postalAddress(venue: JsonLdVenue): Record<string, unknown> {
	const address: Record<string, unknown> = { '@type': 'PostalAddress' };
	if (venue.street) address.streetAddress = venue.street;
	if (venue.city) address.addressLocality = venue.city;
	if (venue.region) address.addressRegion = venue.region;
	if (venue.postcode) address.postalCode = venue.postcode;
	if (venue.country) address.addressCountry = venue.country;
	return address;
}

/**
 * The schema.org FoodEstablishment graph for a venue. `url` is our canonical
 * descriptive page (the same address the head's `<link rel="canonical">` and the
 * sitemap emit); the venue's own site, when known, rides `sameAs`. `hasMenu` is
 * omitted for an empty menu rather than emitted empty.
 */
export function venueJsonLd(venue: JsonLdVenue): Record<string, unknown> {
	const node: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': venue.category ? SCHEMA_TYPE_BY_CATEGORY[venue.category] : 'FoodEstablishment',
		name: venue.name,
		url: `${CANONICAL_ORIGIN}${locationPath(venue)}`,
		address: postalAddress(venue),
		geo: { '@type': 'GeoCoordinates', latitude: venue.latitude, longitude: venue.longitude }
	};
	// schema.org `telephone` wants the international (E.164) number; fall back to the
	// display form for a number whose calling code we cannot resolve (never our data).
	const phone = formatPhone(venue.phone, venue.country);
	if (phone) node.telephone = phone.e164 || phone.display;
	if (venue.website) node.sameAs = venue.website;

	const items = venue.menu.map(menuItemNode);
	if (items.length > 0) node.hasMenu = { '@type': 'Menu', hasMenuItem: items };

	return node;
}

/**
 * The venue graph as a ready-to-inject `<script type="application/ld+json">`
 * element. The HTML-significant characters `<`, `>` and `&` are escaped to their
 * `\uXXXX` JSON forms, so no menu name or description containing `</script>` can
 * break out of the tag — the escaped output still parses back to the identical
 * graph. (U+2028/U+2029 need no escaping here: this is `ld+json` DATA a crawler
 * runs through JSON.parse, not JS source, so both are valid inside its strings.)
 * Consumed via `{@html …}` in the head.
 */
export function venueJsonLdScript(venue: JsonLdVenue): string {
	const json = JSON.stringify(venueJsonLd(venue)).replace(
		/[<>&]/g,
		(ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
	);
	return `<script type="application/ld+json">${json}</script>`;
}
