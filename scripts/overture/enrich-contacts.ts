// ---------------------------------------------------------------------------
// Overture contacts/identity enrichment for the OSM staging store.
//
// Given a staging POI and its matched Overture eatery (nearest name-related
// within the enrich radius — see matchNearestPlaces), this module plans what to
// bank on the POI row:
//   • the identity join itself (overture_id + match distance), banked for EVERY
//     matched POI — later passes (e.g. closure signals) build on it;
//   • gap fills for website / phone / cuisine, with per-field provenance in the
//     same "overture:<id> (<release>)" format as address_source.
//
// The invariant is planOvertureBank's alone: an OSM-sourced value (non-null
// value, null *_source) is NEVER overwritten. Overture-sourced values (their
// *_source says so) are recomputed from the current match on every run, so the
// pass is idempotent and self-correcting. Coordinates are never touched — OSM
// stays the coordinate source (see CLAUDE.md). Pure/deterministic — tested in
// enrich-contacts.test.ts.
// ---------------------------------------------------------------------------

import type { ContactPoi, OvertureBankUpdate } from '../osm/poi-store';

/** One Overture eatery as the contacts pass sees it (from the eateries NDJSON). */
export interface OvertureEatery {
	id: string;
	name: string | null;
	latitude: number;
	longitude: number;
	website: string | null;
	phone: string | null;
	/** First socials[] entry — the fallback when no real website exists. */
	social: string | null;
	/** Overture primary category, e.g. "pizza_restaurant". */
	category: string | null;
}

/** The provenance label banked in *_source columns, matching address_source's format. */
export function overtureSource(id: string, releaseLabel: string): string {
	return `overture:${id} (${releaseLabel})`;
}

/** True when a *_source label marks an Overture-sourced (re-fillable) value. */
export function isOvertureSourced(source: string | null): boolean {
	return source?.startsWith('overture:') ?? false;
}

// Hosts whose URLs are a social profile, not a real website. A profile still
// beats nothing, so these are deprioritized rather than rejected.
const SOCIAL_HOSTS = ['facebook.com', 'fb.com', 'instagram.com', 'linktr.ee', 'linktree.com'];

function isSocialUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

function isHttpUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Picks the website to fill from an Overture eatery: a real (non-social) URL
 * wins; a facebook/instagram/linktree-style profile is still used when it is
 * all the row has (better than nothing). Non-URL junk is dropped.
 */
export function pickWebsite(eatery: Pick<OvertureEatery, 'website' | 'social'>): string | null {
	const candidates = [eatery.website, eatery.social]
		.map((u) => u?.trim() || null)
		.filter((u): u is string => u !== null && isHttpUrl(u));
	return candidates.find((u) => !isSocialUrl(u)) ?? candidates[0] ?? null;
}

/**
 * Conservative Overture-category → OSM-cuisine map: only cuisine-specific
 * categories with an unambiguous, established OSM `cuisine=*` value (lowercase
 * snake_case, per taginfo). Generic venue-type categories (restaurant,
 * fast_food_restaurant, cafe, bar, diner, food_court, bar_and_grill_restaurant,
 * …) are deliberately absent — they say nothing about the food. Dietary-shaped
 * categories (vegan/vegetarian/halal/gluten_free_restaurant) are absent too:
 * dietary designations are source-asserted item data, never venue metadata we
 * derive (see CLAUDE.md).
 */
const CUISINE_BY_CATEGORY: Record<string, string> = {
	pizza_restaurant: 'pizza',
	coffee_shop: 'coffee_shop',
	sandwich_shop: 'sandwich',
	mexican_restaurant: 'mexican',
	american_restaurant: 'american',
	chinese_restaurant: 'chinese',
	burger_restaurant: 'burger',
	ice_cream_shop: 'ice_cream',
	gelato: 'ice_cream',
	frozen_yoghurt_shop: 'frozen_yogurt',
	italian_restaurant: 'italian',
	sushi_restaurant: 'sushi',
	breakfast_and_brunch_restaurant: 'breakfast',
	indian_restaurant: 'indian',
	barbecue_restaurant: 'barbecue',
	seafood_restaurant: 'seafood',
	chicken_restaurant: 'chicken',
	chicken_wings_restaurant: 'wings',
	thai_restaurant: 'thai',
	japanese_restaurant: 'japanese',
	donuts: 'donut',
	steakhouse: 'steak_house',
	vietnamese_restaurant: 'vietnamese',
	asian_restaurant: 'asian',
	bubble_tea: 'bubble_tea',
	mediterranean_restaurant: 'mediterranean',
	taco_restaurant: 'tacos',
	greek_restaurant: 'greek',
	french_restaurant: 'french',
	middle_eastern_restaurant: 'middle_eastern',
	korean_restaurant: 'korean',
	hot_dog_restaurant: 'hot_dog',
	caribbean_restaurant: 'caribbean',
	latin_american_restaurant: 'latin_american',
	fish_and_chips_restaurant: 'fish_and_chips',
	noodles_restaurant: 'noodle',
	ramen_restaurant: 'ramen',
	lebanese_restaurant: 'lebanese',
	filipino_restaurant: 'filipino',
	jamaican_restaurant: 'jamaican',
	african_restaurant: 'african',
	pancake_house: 'pancake',
	portuguese_restaurant: 'portuguese',
	german_restaurant: 'german',
	brazilian_restaurant: 'brazilian',
	pakistani_restaurant: 'pakistani',
	turkish_restaurant: 'turkish',
	persian_iranian_restaurant: 'persian',
	ethiopian_restaurant: 'ethiopian',
	dim_sum_restaurant: 'dim_sum',
	peruvian_restaurant: 'peruvian',
	hawaiian_restaurant: 'hawaiian',
	spanish_restaurant: 'spanish',
	polish_restaurant: 'polish',
	afghan_restaurant: 'afghan',
	cuban_restaurant: 'cuban',
	doner_kebab: 'kebab',
	bagel_shop: 'bagel',
	bagel_restaurant: 'bagel'
};

/** OSM cuisine value for an Overture category, or null when not cleanly mappable. */
export function cuisineForCategory(category: string | null): string | null {
	return category ? (CUISINE_BY_CATEGORY[category] ?? null) : null;
}

/** True when the POI's own (OSM) data owns this field: enrichment must not touch it. */
function osmOwned(value: string | null, source: string | null): boolean {
	return value !== null && value.trim() !== '' && !isOvertureSourced(source);
}

/**
 * Plans the bank row for one matched POI. The overture_id + distance are always
 * (re)banked; each of website/phone/cuisine is filled only when missing or
 * previously Overture-sourced — in the latter case it is recomputed from the
 * CURRENT match (and cleared when the match no longer carries a value), which
 * is what makes re-runs idempotent. OSM-sourced values pass through verbatim.
 */
export function planOvertureBank(
	poi: ContactPoi,
	eatery: OvertureEatery,
	distanceM: number,
	releaseLabel: string
): OvertureBankUpdate {
	const source = overtureSource(eatery.id, releaseLabel);
	const fill = (
		current: string | null,
		currentSource: string | null,
		fromMatch: string | null
	): { value: string | null; source: string | null } => {
		if (osmOwned(current, currentSource)) return { value: current, source: currentSource };
		return { value: fromMatch, source: fromMatch === null ? null : source };
	};

	const website = fill(poi.website, poi.website_source, pickWebsite(eatery));
	const phone = fill(poi.phone, poi.phone_source, eatery.phone?.trim() || null);
	const cuisine = fill(poi.cuisine, poi.cuisine_source, cuisineForCategory(eatery.category));

	return {
		osm_id: poi.osm_id,
		overture_id: eatery.id,
		overture_distance_m: Math.round(distanceM * 10) / 10,
		website: website.value,
		website_source: website.source,
		phone: phone.value,
		phone_source: phone.source,
		cuisine: cuisine.value,
		cuisine_source: cuisine.source
	};
}
