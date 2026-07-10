// ---------------------------------------------------------------------------
// missing_course_tag audit: menu items with NO required (non-optional) course
// tag (food/dessert/drink).
//
// Course tags became a completeness mandate after the pre-mandate item corpus
// (~12k items) was written with only dietary tags — this audit is the backlog
// detector AND the drain mechanism: every existing item that predates the
// mandate shows up here until it is re-tagged via update_items. A missing
// course tag means "never course-reviewed" (never "food" by default — see
// src/lib/tags.ts), so nothing is inferred automatically; each flagged item
// carries a cheap keyword `hint` ('drink' | 'dessert' | null) to speed up
// manual verification, never to auto-apply.
//
// PAGED (unlike the other single-page audits): the pre-mandate backlog is large
// enough that a caller drains it over many calls. `total` is the full flagged
// count; `limit`/`offset` page through it, ordered hint-first (drink, then
// dessert, then no hint) and then by menu, so the backlog can be worked through
// systematically menu-by-menu.
//
// Reads only the live D1 (no OSM store), like find-incomplete-menus /
// find-html-entities.
// ---------------------------------------------------------------------------

import type { D1Like } from '../../src/lib/server/db';
import { TAGS } from '../../src/lib/tags';
import { DismissFilter, type DismissableFinding, type DismissalOpts } from './audit-dismiss';

const courseTagIds = TAGS.filter((t) => t.tag_type === 'course').map((t) => t.id);

/** One flagged item on the missing-course-tag work-list. */
export interface MissingCourseTagItem extends DismissableFinding {
	id: string;
	item_name: string;
	menu_id: string;
	menu_name: string;
	/** Live (non-closed) locations currently serving this item's menu. */
	location_count: number;
	/** Cheap keyword heuristic suggesting the likely tag — verify, never auto-apply. */
	hint: 'drink' | 'dessert' | null;
}

export interface FindMissingCourseTagsResult {
	items: MissingCourseTagItem[];
	/** All items missing a required course tag, across the whole DB. */
	total: number;
	/** How many of those are in `items` (≤ limit). */
	returned: number;
	/** Flagged items NOT returned because of `limit`/`offset` (total - returned). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
	limit: number;
	offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Word-boundary keyword lists. Whole-word matching only (never substrings), so
// "chocolate" does not match "cola" and "platter" does not match "latte" —
// "crab cake" matching "cake" is an accepted, useful false-positive.
const DRINK_WORDS = [
	'latte',
	'coffee',
	'espresso',
	'cappuccino',
	'americano',
	'mocha',
	'macchiato',
	'juice',
	'smoothie',
	'lassi',
	'lemonade',
	'milkshake',
	'shake',
	'soda',
	'pop',
	'cola',
	'iced tea',
	'tea',
	'chai',
	'hot chocolate',
	'frappe',
	'frappuccino',
	'slush',
	'kombucha',
	'water'
];

const DESSERT_WORDS = [
	'cheesecake',
	'ice cream',
	'cookie',
	'brownie',
	'sundae',
	'donut',
	'doughnut',
	'gelato',
	'baklava',
	'tiramisu',
	'mousse',
	'churro',
	'custard',
	'pudding',
	'cake',
	'pie',
	'tart',
	'pastry',
	'dessert',
	'kulfi',
	'gulab'
];

function wordBoundaryRegex(words: string[]): RegExp {
	const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}

const DRINK_REGEX = wordBoundaryRegex(DRINK_WORDS);
const DESSERT_REGEX = wordBoundaryRegex(DESSERT_WORDS);

/** Cheap keyword suggestion for a likely course tag — a hint to verify, not to trust. */
function hintFor(itemName: string): 'drink' | 'dessert' | null {
	const lower = itemName.toLowerCase();
	if (DRINK_REGEX.test(lower)) return 'drink';
	if (DESSERT_REGEX.test(lower)) return 'dessert';
	return null;
}

const HINT_RANK: Record<'drink' | 'dessert' | 'none', number> = { drink: 0, dessert: 1, none: 2 };

interface MissingCourseTagRow {
	id: string;
	item_name: string;
	menu_id: string;
	menu_name: string;
	location_count: number;
}

/**
 * Flags every item with NO required (non-optional) course tag. `limit` (default
 * 50, max 200) and `offset` page the full flagged set; `total` is the count
 * across the whole DB, `additional` what remains beyond this page.
 */
export async function findMissingCourseTags(
	db: D1Like,
	opts: { limit?: number; offset?: number } & DismissalOpts = {}
): Promise<FindMissingCourseTagsResult> {
	const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
	const filter = new DismissFilter(opts);

	const placeholders = courseTagIds.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT i.id AS id, i.item_name AS item_name, i.menu_id AS menu_id, m.name AS menu_name,
			        (SELECT COUNT(*) FROM locations l
			           WHERE l.menu_id = i.menu_id AND l.closed_at IS NULL) AS location_count
			 FROM items i
			 JOIN menus m ON m.id = i.menu_id
			 WHERE NOT EXISTS (
			   SELECT 1 FROM item_tags it
			   WHERE it.item_id = i.id AND it.optional = 0 AND it.tag_id IN (${placeholders})
			 )
			 ORDER BY m.name ASC, i.item_name ASC`
		)
		.bind(...courseTagIds)
		.all<MissingCourseTagRow>();

	// Dismissals here should be RARE (the course-tag mandate wants a tag on every
	// item), but the generic mechanism still applies — e.g. an item whose course
	// genuinely cannot be sourced yet.
	const flagged: MissingCourseTagItem[] = [];
	for (const r of results) {
		const decision = filter.evaluate(r.id, '');
		if (decision.drop) continue;
		flagged.push({
			id: r.id,
			item_name: r.item_name,
			menu_id: r.menu_id,
			menu_name: r.menu_name,
			location_count: r.location_count,
			hint: hintFor(r.item_name),
			...decision.fields
		});
	}

	// Hint-first (drink, then dessert, then no hint), then by menu/item name — the
	// SQL ORDER BY already sorted by menu/item name, so this sort is stable within
	// each hint bucket.
	flagged.sort((a, b) => HINT_RANK[a.hint ?? 'none'] - HINT_RANK[b.hint ?? 'none']);

	const items = flagged.slice(offset, offset + limit);
	return {
		items,
		total: flagged.length,
		returned: items.length,
		additional: flagged.length - offset - items.length,
		suppressed_dismissed: filter.suppressed,
		limit,
		offset
	};
}
