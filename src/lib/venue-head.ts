/**
 * Head metadata (SEO title, meta description, canonical URL) for an open venue.
 *
 * Pure and client-safe (no server/runtime deps) so scripts/venue-head.test.ts
 * can pin the SEO copy without mounting the page. Consumed by the `headMeta`
 * derived in src/routes/+page.svelte, which server-renders it into the document
 * head on a hard `/locations/<id>` load — the only markup crawlers and link
 * unfurlers see for a venue.
 *
 * Two SEO levers over the old "{name} - BetterFoodMaps" head (issue #222):
 *   • the TITLE leads with the city — "{name} – {city}, {region} | BetterFoodMaps"
 *     — a city being the #1 query modifier for a restaurant search;
 *   • the DESCRIPTION surfaces dietary coverage ("12 vegan and 8 gluten-free
 *     menu items") — the diet-filtered query intent this map serves that a
 *     general map can't, derived from the menu already fetched for the panel.
 */

import { categoryLabel, type Category } from './category';
import { TAGS } from './tags';

/**
 * The canonical public origin for `og:url` — a shared `/locations/<id>` link
 * should unfurl against the production URL regardless of which host served it.
 */
export const CANONICAL_ORIGIN = 'https://betterfoodmaps.com';

/** The fields the head metadata reads off a resolved venue. */
export interface HeadVenue {
	id: string;
	name: string;
	category: Category | null;
	/** Municipality, e.g. "Guelph". */
	city: string;
	/** 2-letter province/state code, e.g. "ON". */
	region: string;
	/** The venue's effective menu — only each item's tag ids are read here. */
	menu: ReadonlyArray<{ tags: ReadonlyArray<{ id: string }> }>;
}

/** The head fields the page renders (`<title>` / description / canonical URL). */
export interface HeadMeta {
	title: string;
	description: string;
	url: string;
}

/** The six dietary tags in display order (course tags never surface here). */
const DIETARY_TAGS = TAGS.filter((tag) => tag.tag_type === 'dietary');

/** `"a"` | `"a and b"` | `"a, b and c"` — serial join, no Oxford comma. */
function joinList(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The dietary-coverage clause for a menu — e.g. "12 vegan and 8 gluten-free menu
 * items" — or null when no item carries any dietary tag (the description then
 * falls back to a plain item count).
 *
 * Counts items carrying each dietary tag id DIRECTLY, deliberately NOT through
 * the vegan ⊃ vegetarian ⊃ dairy-free implication closure the map's diet FILTER
 * uses (dietFilterTagIds). The description exists to surface DISTINCT diet axes
 * — so gluten-free shows alongside vegan, exactly as issue #222 intends — rather
 * than letting a vegan-heavy menu fill every slot with vegan plus its two
 * entailed diets and crowd out the allergen axes a searcher actually queries.
 * Lists the best-covered `limit` diets, strongest first (ties broken by display
 * order), so the strongest hook leads and the clause stays description-length.
 */
export function dietaryCoverageClause(menu: HeadVenue['menu'], limit = 3): string | null {
	const covered = DIETARY_TAGS.map((tag, order) => ({
		label: tag.name.toLowerCase(),
		count: menu.reduce((n, item) => n + (item.tags.some((t) => t.id === tag.id) ? 1 : 0), 0),
		order
	}))
		.filter((diet) => diet.count > 0)
		.toSorted((a, b) => b.count - a.count || a.order - b.order)
		.slice(0, limit);
	if (covered.length === 0) return null;
	// The shared "menu item(s)" head noun reads singular only when the whole
	// clause is a lone count of one ("1 vegan menu item").
	const singular = covered.length === 1 && covered[0].count === 1;
	return `${joinList(covered.map((diet) => `${diet.count} ${diet.label}`))} menu item${singular ? '' : 's'}`;
}

/**
 * Title, description and canonical URL for a venue's document head. The title
 * leads with the venue name then its city/region; the description opens with
 * what-and-where and closes on the menu's dietary coverage (or a plain item
 * count when the menu carries no dietary tags). Both degrade gracefully when a
 * part is missing.
 */
export function venueHeadMeta(venue: HeadVenue): HeadMeta {
	const where = [venue.city, venue.region]
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join(', ');
	const title = `${venue.name}${where ? ` – ${where}` : ''} | BetterFoodMaps`;

	const category = categoryLabel(venue.category);
	const lead = `${venue.name}${category ? `, ${category.toLowerCase()}` : ''}${where ? ` in ${where}` : ''}.`;

	const coverage = dietaryCoverageClause(venue.menu);
	const count = venue.menu.length;
	const tail = coverage
		? `${coverage} on BetterFoodMaps.`
		: count > 0
			? `${count} menu item${count === 1 ? '' : 's'} on BetterFoodMaps.`
			: 'See the menu on BetterFoodMaps.';

	return {
		title,
		description: `${lead} ${tail}`,
		url: `${CANONICAL_ORIGIN}/locations/${encodeURIComponent(venue.id)}`
	};
}
