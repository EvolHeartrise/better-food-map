/**
 * Head metadata (SEO title, meta description, canonical URL) for an open venue.
 *
 * Client-safe: its only dependency beyond sibling pure modules is Paraglide's
 * message runtime, which resolves the caller's locale per request server-side
 * and falls back to the base locale ('en-US') OUTSIDE a request — so the sitemap /
 * prerender path and scripts/venue-head.test.ts both see the English SEO copy
 * (the English message values are kept byte-identical to the old literals, so
 * the pinned test output is unchanged). Consumed by the `headMeta`
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
import { TAGS, tagDisplayName } from './tags';
import { locationPath } from './location-path';
import { CANONICAL_ORIGIN } from './canonical';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';

// Re-exported for backward compatibility: the shared origin now lives in
// ./canonical (one definition for the head, the sitemap and the browse pages).
export { CANONICAL_ORIGIN };

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

/**
 * `"a"` | `"a and b"` | `"a, b and c"` — serial join, no Oxford comma. Both the
 * separator (head_list_sep: "、" in zh/yue, "، " in ar) and the final pair
 * (head_list_pair) are message-driven so a locale owns its list punctuation.
 */
function joinList(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	return m.head_list_pair({
		first: parts.slice(0, -1).join(m.head_list_sep()),
		last: parts[parts.length - 1]
	});
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
		// The diet word localizes through the shared tag-label helper (English
		// values match the old `tag.name`, lower-cased for mid-sentence flow —
		// locale-aware, and diet labels are adjectives so they lowercase even in
		// German, unlike the category noun in venueHeadMeta).
		label: tagDisplayName(tag.id).toLocaleLowerCase(getLocale()),
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
	// The clause's shape is message-driven so a locale can reorder it instead of
	// inflecting the diet labels: English keeps "12 vegan and 8 gluten-free menu
	// items" (count-adjective-noun, pinned byte-for-byte by the head test), while
	// French reads "Au menu : végétalien (12) et sans gluten (8)" — the per-diet
	// part (head_coverage_diet) and the frame (head_coverage_clause) each localize;
	// a locale that doesn't need {noun} simply leaves it out of its pattern.
	return m.head_coverage_clause({
		list: joinList(
			covered.map((diet) => m.head_coverage_diet({ count: diet.count, diet: diet.label }))
		),
		noun: m.head_menu_item_noun({ count: singular ? 1 : 2 })
	});
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

	// The lead's frame is message-driven — the category/where clauses carry their
	// own separators (head_lead_category/head_lead_where) and head_lead its own
	// terminator — so a locale controls its punctuation (zh/yue ，/。, ar/ur/fa ،,
	// hi/pa ।, ur ۔) instead of inheriting the English ", " / " " / ".".
	const category = categoryLabel(venue.category);
	const locale = getLocale();
	// Mid-sentence the category noun lowercases — except in German, where nouns
	// keep their capital anywhere in the sentence.
	const midSentenceCategory = locale === 'de' ? category : category.toLocaleLowerCase(locale);
	const lead = m.head_lead({
		name: venue.name,
		categoryClause: category ? m.head_lead_category({ category: midSentenceCategory }) : '',
		whereClause: where ? m.head_lead_where({ locatedIn: m.head_located_in({ where }) }) : ''
	});

	const coverage = dietaryCoverageClause(venue.menu);
	const count = venue.menu.length;
	const tail = coverage
		? m.head_desc_on_brand({ content: coverage })
		: count > 0
			? m.head_desc_on_brand({
					// The plain-count fallback is a message so a locale can reorder or
					// add a counter word (ko "메뉴 5개", fil "5 na menu item").
					content: m.head_plain_count({ count, noun: m.head_menu_item_noun({ count }) })
				})
			: m.head_desc_no_menu();

	return {
		title,
		// head_desc joins the two sentences — a space in most locales, none in zh/yue.
		description: m.head_desc({ lead, tail }),
		// The canonical descriptive URL (`/locations/<name>-<city>-<uuid>`, issue
		// #221) — the SAME address the sitemap emits and the server 301s bare/
		// wrong-slug URLs onto, shared through locationPath so all three can't drift.
		url: `${CANONICAL_ORIGIN}${locationPath(venue)}`
	};
}
