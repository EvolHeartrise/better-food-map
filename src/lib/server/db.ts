// ---------------------------------------------------------------------------
// Cloudflare D1 data-access layer.
//
// This module is RUNTIME-AGNOSTIC: it contains no connection of its own. Every
// function takes a `D1Like` handle and is async, so the same code runs against
// either the Worker's D1 binding (`platform.env.DB`) in the deployed app, or the
// HTTP-backed client in `d1-http.ts` used by the MCP server and the seed script.
// Keep it free of `bun:sqlite`, `node:*`, and other non-Worker imports.
//
// Data model (see migrations/0004_unify_items_and_tags.sql):
//   * One `items` table holds every menu item. An item belongs to a `menu`.
//   * An independent venue has its OWN private menu (brand_id NULL), referenced
//     by just that one location; a chain branch references its shared brand
//     menu. Either way a location's effective menu is "the items of
//     locations.menu_id, with this location's overrides applied".
//   * One `tags` vocabulary (id, name, tag_type) with tag_type 'dietary' |
//     'course'. Items link to tags through `item_tags`, whose `optional` flag
//     marks a tag that can be added or left out (e.g. "can be made vegan").
// ---------------------------------------------------------------------------

// Type-only imports (erased at build time, so they add no runtime dependency and
// keep this module runtime-agnostic). `category.ts`, `tags.ts` and `bounds.ts` are
// the canonical, client-safe homes of these shapes; re-exported below as part of
// this module's contract.
import type { Category } from '../category';
import type { Bounds } from '../bounds';
import type { Tag, TagId, TagType } from '../tags';
import type { SitemapEntry } from './sitemap';
import type { Locale } from '../paraglide/runtime';
// Value imports (tiny, pure, client-safe): the canonical display-address formatter,
// so the single-line `address` is composed identically wherever a location is read,
// and the canonical tag vocabulary.
import { TAGS, dietFilterTagIds } from '../tags';
import { formatAddress } from '../address';
import { longestLiteralRun, searchableQuery } from '../search';
import { cellKey, cellsCoverBounds, levelCell } from '../grid';

// ---------------------------------------------------------------------------
// Minimal D1 interface (the real `D1Database` binding and the HTTP shim in
// `d1-http.ts` are both structurally assignable to these).
// ---------------------------------------------------------------------------

export interface D1PreparedLike {
	bind(...values: unknown[]): D1PreparedLike;
	first<T = unknown>(): Promise<T | null>;
	all<T = unknown>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Like {
	prepare(query: string): D1PreparedLike;
	/** Runs the given statements atomically (all-or-nothing). */
	batch(statements: D1PreparedLike[]): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// Types (STABLE CONTRACT — other agents depend on these exact names)
// ---------------------------------------------------------------------------

export type { Category, Bounds, Tag, TagId, TagType };
export { TAGS };

/** A tag as applied to a specific item, carrying the per-edge `optional` flag. */
export interface ItemTag extends Tag {
	/** True if this tag is optional for the item (e.g. "can be made vegan"). */
	optional: boolean;
}

/**
 * The LEAN per-edge tag shape the bulk viewport/search payloads carry: just the
 * tag id and the per-edge `optional` flag. The tag vocabulary is closed (the six
 * dietary + two course tags) and bundled client-side as `TAGS` ($lib/tags), so
 * `name`/`tag_type` are derivable from the id and shipping them on every
 * item-tag edge of a dense viewport was pure payload weight. The detail/MCP
 * reads keep the full {@link ItemTag} (which satisfies this shape structurally).
 */
export interface MapItemTag {
	id: string;
	/** True if this tag is optional for the item (e.g. "can be made vegan"). */
	optional: boolean;
}

/**
 * A citation for where a record's data was obtained. A record may have any
 * number of sources (including none); each is a URL with an optional label.
 */
export interface Source {
	/** URL the data was obtained from. */
	url: string;
	/** Optional human-readable label, e.g. "Official menu". */
	label: string | null;
}

export interface Location {
	id: string;
	name: string;
	category: Category | null;
	latitude: number;
	longitude: number;
	/** House number + street (+ unit), e.g. "1909 W 4th Ave". */
	street: string;
	/** Municipality, e.g. "Vancouver". */
	city: string;
	/** 2-letter province/state code, e.g. "BC". */
	region: string;
	/** Postal/ZIP code in canonical form, or null when none could be resolved. */
	postcode: string | null;
	/** ISO-3166-1 alpha-2 country code, e.g. "CA". */
	country: string;
	/**
	 * Canonical single-line display address, DERIVED from the structured parts via
	 * {@link formatAddress} on read (never stored), so it is always normalized.
	 */
	address: string;
	phone: string | null;
	website: string | null;
	/**
	 * Weekly hours as the RAW source string in OSM `opening_hours` syntax (e.g.
	 * "Mo-Fr 08:00-18:00; Sa 09:00-17:00"), normalized via
	 * {@link import('../opening-hours').normalizeOpeningHours} on write. The
	 * provenance/interchange form; null when unknown (~75% of OSM food POIs).
	 */
	opening_hours: string | null;
	/**
	 * The SAME hours as a canonical weekly table, DERIVED on write from
	 * {@link opening_hours} (see src/lib/opening-hours.ts weeklyHoursJson): JSON
	 * of 7 Monday-first day entries of [openMinute, closeMinute) spans. Never
	 * set directly — the write layer derives it, so the pair cannot drift. Null
	 * when there are no hours OR the raw string is beyond the parsed subset
	 * (the UI then shows the raw string verbatim).
	 */
	opening_hours_json: string | null;
	/** Chain this location belongs to, or `null` for an independent venue. */
	brand_id: string | null;
	/**
	 * The menu this location serves: a shared brand menu (chain branch), or its
	 * own private menu (independent venue). `null` only when it has no menu/items.
	 * Provenance lives on that menu ({@link Menu.sources}), not on the location.
	 */
	menu_id: string | null;
}

/**
 * The LEAN item shape the viewport/search payloads carry (see {@link MapData}).
 * The map UI renders only item names (the rotating label teasers) and re-filters
 * by dietary tag client-side, so this is all a bulk payload needs; description
 * and price are read solely in the detail panel of the ONE open venue,
 * which resolves through the by-id read (full {@link Item} shape). Shipping the
 * full shape for every in-view menu made a dense-viewport pan serialize hundreds
 * of KB that was never rendered (#83).
 */
export interface MapItem {
	id: string;
	menu_id: string;
	item_name: string;
	/**
	 * Tags applied to this item (dietary and course), as lean id+`optional`
	 * edges — the client resolves display name/type from the bundled TAGS
	 * vocabulary (see {@link MapItemTag}).
	 */
	tags: MapItemTag[];
}

/**
 * A menu item, in full. Belongs to a {@link Menu} — private to one venue, or
 * shared across a chain's branches. Unlike the lean {@link MapItem}, its tags
 * are full {@link ItemTag}s (name/tag_type included) — the detail and MCP reads
 * keep the self-describing shape.
 */
export interface Item extends MapItem {
	tags: ItemTag[];
	/** Short free-text description of the item (may be null). */
	description: string | null;
	price: number | null;
	/**
	 * Upper-case ISO-4217 code the {@link price} is denominated in, taken from the
	 * item's menu on read (see {@link Menu.currency}) so a price is always
	 * self-describing. Defaults to "CAD".
	 */
	currency: string;
}

export interface LocationWithTags extends Location {
	/** Distinct dietary/course tags offered across this location's menu. */
	tags: Tag[];
}

/**
 * A location plus the per-item overrides it applies to its menu. The client
 * joins it to the matching `menus` entry — applying these overrides — to rebuild
 * the effective menu, so a shared brand menu is sent once rather than per branch.
 * See {@link MapData}.
 */
export interface MapLocation extends Location {
	/** Per-item deviations from its menu (empty unless it overrides one). */
	overrides: LocationItemOverride[];
	/**
	 * Importance score the client's label declutter ranks by, so the pill that
	 * survives a crowded screen cell is the venue users actually care about —
	 * the same per-cell ranking term the server uses ({@link getMapCellsData}).
	 * Derived from ratings + bookmarks ({@link locationScoreSql}) but deliberately
	 * named opaquely on the wire: the payload is public, and this shouldn't read
	 * as (or be relied on as) an exact tally of either.
	 */
	score: number;
}

/**
 * Everything the map page needs in one payload. Each menu (private or shared) is
 * sent ONCE, keyed by `menu_id`, with its items resolved (tags attached); a
 * 500-branch chain ships its menu a single time instead of 500. The client
 * joins each {@link MapLocation} to its `menus` entry, applying the location's
 * `overrides`, to reconstruct the effective menu (see `resolveLocation` in +page.svelte).
 *
 * The default item shape is the LEAN {@link MapItem} — what the bulk
 * viewport/search reads return. Only the single-venue by-id read
 * ({@link getLocationMapData}, backing the detail panel) instantiates this with
 * the full {@link Item} (description, price) — see #83.
 */
export interface MapData<I extends MapItem = MapItem> {
	locations: MapLocation[];
	/** Menus referenced by the returned locations, items resolved once, keyed by menu_id. */
	menus: Record<string, I[]>;
	/**
	 * Per-menu metadata for the referenced menus, keyed by menu_id: `last_verified`
	 * (the ISO date a menu was last checked against its source) and the menu's
	 * `sources` (its provenance citations, now the ONLY level sources live at). Sent
	 * once per menu alongside {@link menus} so the detail view can show a venue's
	 * freshness + sources without a second read. `sources` is populated only on the
	 * by-id detail read (the lean viewport payload ships `[]` — the map never renders
	 * them); every menu carries a `last_verified` date (enforced by migration 0012's
	 * triggers), typed nullable only because the read column is.
	 *
	 * `matchingItemCount` rides only on the lean, item-capped viewport/search reads
	 * (see {@link REP_ITEM_CAP}): the number of the menu's items that MATCH the
	 * active filter BEFORE the top-N cut (the whole menu in browse). `menus[id]`
	 * carries at most `REP_ITEM_CAP` of them, so this keeps the true total for a
	 * "showing 10 of N" affordance. Absent on the uncapped by-id detail read.
	 */
	menuMeta: Record<
		string,
		{ last_verified: string | null; sources: Source[]; matchingItemCount?: number }
	>;
}

// ---------------------------------------------------------------------------
// Chain model: a brand owns regional menus; a menu owns items; a location
// serves a menu (locations.menu_id) — a shared brand menu, or its own private one.
// ---------------------------------------------------------------------------

/** A restaurant chain / brand (e.g. McDonald's). Independent venues have none. */
export interface Brand {
	id: string;
	name: string;
	website: string | null;
	/** URL of the brand's logo/marker image, or null. */
	logo_url: string | null;
}

/** A set of items served by one or more locations (a chain menu, or a venue's private menu). */
export interface Menu {
	id: string;
	/** Owning brand, or null for a private/standalone menu not tied to a chain. */
	brand_id: string | null;
	/** Display name, e.g. "Subway UK". */
	name: string;
	/** Free-form scope label, e.g. "GB", "US-CA", "Canada". */
	region: string | null;
	/**
	 * Upper-case ISO-4217 code every item price on this menu is denominated in
	 * (e.g. "CAD", "USD", "GBP"). One currency per menu — set it once here rather
	 * than per item. Defaults to "CAD".
	 */
	currency: string;
	/** ISO date the menu was last checked against the source (chain menus go stale). */
	last_verified: string | null;
	/**
	 * Free-form notes on HOW to refresh this menu's data — the machine-readable
	 * feed endpoint behind a client-rendered menu page, a nutrition-PDF path,
	 * fetch caveats. Banked once at research time so a re-verification doesn't
	 * have to re-discover the source (that discovery dominates refresh cost).
	 */
	refresh_notes: string | null;
	/** Citations for where this menu's data came from (may be empty). */
	sources: Source[];
}

export interface MenuWithItems extends Menu {
	items: Item[];
}

/** Lightweight menu listing row (no items/sources), with an item count. */
export interface MenuSummary {
	id: string;
	brand_id: string | null;
	name: string;
	region: string | null;
	/** Upper-case ISO-4217 currency code for this menu's prices (see {@link Menu.currency}). */
	currency: string;
	last_verified: string | null;
	item_count: number;
	/** OPEN branches currently serving this menu (closed ones are excluded). */
	location_count: number;
}

/** Default currency for a menu when none is specified (the Canada-first dataset). */
export const DEFAULT_CURRENCY = 'CAD';

/** A single location's deviation from its menu, stored only where it differs. */
export interface LocationItemOverride {
	location_id: string;
	item_id: string;
	/** `false` = not served here; `null` = inherit the menu default (served). */
	available: boolean | null;
	/** Overriding price here, or `null` to inherit the item's price. */
	price: number | null;
}

/**
 * Internal raw shape of an `items` row before its tags and (menu-derived)
 * currency are attached. `currency` is NOT a column on `items`; it is read from the
 * item's menu and attached when the {@link Item} is assembled. A LEAN read
 * (queryMapData without `detail`) projects only the {@link MapItem} columns, so
 * `description`/`price` are undefined at runtime there — the lean path never reads them.
 */
export type ItemRow = Omit<Item, 'tags' | 'currency'>;

/** Raw `location_item_overrides` row (`available` stored as 0/1/NULL). */
export interface OverrideRow {
	location_id: string;
	item_id: string;
	available: number | null;
	price: number | null;
}

/** Internal raw shape of a `locations` row before its derived `address` is attached. */
// The raw DB row: the structured columns, but not the derived `address` (composed on read).
export type LocationRow = Omit<Location, 'address'>;

/** Raw `menu_sources` row keyed by its owner menu id. */
interface SourceRow {
	owner_id: string;
	url: string;
	label: string | null;
}

/** A LEAN (item, tag) join row: just the edge, no `tags`-table columns. */
interface MapItemTagRow {
	owner_id: string;
	id: string;
	optional: number;
}

/** An (item, tag) join row, with the per-edge `optional` flag (0/1). */
export interface ItemTagRow extends MapItemTagRow {
	name: string;
	tag_type: TagType;
}

/** Groups raw source rows by owner id, preserving insertion order within each. */
function groupSources(rows: SourceRow[]): Map<string, Source[]> {
	const byOwner = new Map<string, Source[]>();
	for (const row of rows) {
		const list = byOwner.get(row.owner_id) ?? [];
		list.push({ url: row.url, label: row.label });
		byOwner.set(row.owner_id, list);
	}
	return byOwner;
}

/** Groups (item, tag) join rows into an {@link ItemTag} list per item, preserving order. */
export function groupItemTags(rows: ItemTagRow[]): Map<string, ItemTag[]> {
	const byOwner = new Map<string, ItemTag[]>();
	for (const row of rows) {
		const list = byOwner.get(row.owner_id) ?? [];
		list.push({
			id: row.id,
			name: row.name,
			tag_type: row.tag_type,
			optional: row.optional !== 0
		});
		byOwner.set(row.owner_id, list);
	}
	return byOwner;
}

/** Groups LEAN (item, tag) join rows into a {@link MapItemTag} list per item. */
function groupMapItemTags(rows: MapItemTagRow[]): Map<string, MapItemTag[]> {
	const byOwner = new Map<string, MapItemTag[]>();
	for (const row of rows) {
		const list = byOwner.get(row.owner_id) ?? [];
		list.push({ id: row.id, optional: row.optional !== 0 });
		byOwner.set(row.owner_id, list);
	}
	return byOwner;
}

// ---------------------------------------------------------------------------
// SQL (D1 enforces foreign keys; schema lives in migrations/)
// ---------------------------------------------------------------------------

export const LOCATION_FIELDS = `id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, opening_hours, opening_hours_json, brand_id, menu_id`;
export const ITEM_FIELDS = `id, menu_id, item_name, description, price`;
/** The lean {@link MapItem} projection the bulk viewport/search reads use (#83). */
const MAP_ITEM_FIELDS = `id, menu_id, item_name`;
/** Item-tag join projection (aliased to {@link ItemTagRow}). */
export const ITEM_TAG_SELECT = `t.id AS id, t.name AS name, t.tag_type AS tag_type, it.optional AS optional`;
/**
 * The LEAN item-tag projection the bulk viewport/search reads use (aliased to
 * {@link MapItemTagRow}): both columns live on `item_tags` itself, so nothing
 * from the `tags` table ships — the client resolves display fields from the
 * bundled TAGS vocabulary (see {@link MapItemTag}).
 */
const MAP_ITEM_TAG_SELECT = `it.tag_id AS id, it.optional AS optional`;

/**
 * Hard cap on how many locations a single search/list read returns. The map's
 * browse reads are bounded separately — per grid cell ({@link getMapCellsData}),
 * with the per-request cell count capped so a rep-level batch never exceeds
 * this either (GRID_REP_LIMIT in $lib/grid is numerically this value; asserted
 * in grid.test.ts, since the client-safe grid module cannot import this one).
 */
export const MAP_RESULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`). When the
 * result equals the input, nothing needed escaping — the pattern then carries no
 * escape character, so the `ESCAPE` clause may be omitted without changing what
 * the LIKE matches (searchMembership relies on this to keep the FTS5 trigram
 * pushdown, which an ESCAPE clause would disable — see migration 0016).
 */
export function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// --- Viewport grid cells ----------------------------------------------------
// The map's browse reads are keyed on the absolute grid defined in $lib/grid:
// the client picks a LEVEL for its viewport (level 0 = full tiles for a
// neighbourhood view; level k ≥ 1 = one representative per rung-k cell for a
// wide one), enumerates the cells covering it, and asks only for the cells it
// hasn't cached. A cell's contents depend on the DATA alone — never on the
// viewport or on which other cells share the request — which is what makes a
// cell cacheable client-side across pans (#84) and server-side across visitors
// (#93). The grid math (ladder, level selection, cell indexing) lives in
// $lib/grid so client and server floor identically; this module owns only the
// SQL that materializes a cell.

/**
 * Per-cell venue cap on the FULL level: a 0.02°(~2.2 km) tile in a dense core
 * ships at most this many venues, importance-ranked — a venue WITH a menu
 * outranks one without, then more-liked outranks less (matching the rep-level
 * ranking) — so one downtown tile can't blow up the payload.
 */
export const FULL_CELL_CAP = 100;

/**
 * Per-cell venue cap on a REPRESENTATIVE level: each rung-k cell ships its top
 * {@link REP_CELL_CAP} venues by the same importance ranking (menu'd first,
 * then more-liked, then name/id), not just its single winner. A handful per
 * cell reads as a legible spread while still surfacing runners-up a lone
 * representative would hide — a cell's whole contents remain a pure function of
 * the data (the top-N of a partition is order-stable), so it caches per-cell
 * across pans and visitors exactly as the 1-per-cell read did. The per-request
 * cell count is still bounded by the coarsening invariant (GRID_REP_LIMIT), so
 * a rep batch resolves at most REP_CELL_CAP × that many locations.
 */
export const REP_CELL_CAP = 3;

/**
 * Per-menu item cap on the lean viewport/search payload: a referenced menu
 * ships at most this many items — its most-liked MATCHING items (see
 * {@link ItemCap}) — instead of its whole card. A 300-item chain menu that the
 * map only draws a pin for no longer serializes 300 lean items per viewport;
 * the full menu still loads on demand through the by-id detail read (which is
 * never capped) when a venue's panel opens. The true pre-cap count rides on
 * {@link MapData.menuMeta}'s `matchingItemCount` so a "showing 10 of N"
 * affordance keeps the total.
 */
export const REP_ITEM_CAP = 10;

/**
 * How {@link queryMapData} caps a menu's items on the lean path. `dietTagIds`
 * is the active dietary selector's implication closure ({@link dietFilterTagIds})
 * — empty for plain browse, in which case every item is a "match"; when set,
 * only items carrying one of those tags are kept. The kept set is then ranked by
 * item score ({@link itemScoreSql}, desc, name/id for determinism) and cut to `limit`. Passed
 * ONLY when there is no active free-text term: a text query matches per-VENUE
 * (name OR item, across a SHARED menu), so capping a shared menu's items could
 * drop the very item a branch matched on — the client re-filter would then hide
 * that marker. With no cap under text, the client's item-level text filter still
 * sees the whole menu. Never passed on the detail read (the panel needs the full
 * menu).
 */
export interface ItemCap {
	dietTagIds: string[];
	limit: number;
}

/**
 * A {@link MapData} payload plus the per-cell membership it was asked for:
 * `cells` maps every REQUESTED cell key to the ids of its locations — an empty
 * array for an empty cell, which the caches store as a negative entry so open
 * ocean isn't re-queried forever.
 */
export interface MapCellsData extends MapData {
	cells: Record<string, string[]>;
}

/**
 * The map payload for a set of same-level grid cells (see $lib/grid for what a
 * level is). Partitions the open venues onto the level's absolute lattice and,
 * per requested cell, keeps the top venues by importance — menu'd first, then
 * liked (a correlated index probe per candidate row, not a whole-likes-table
 * aggregation — #93), then name/id for determinism; one per cell on a
 * representative level, {@link FULL_CELL_CAP} on the full level. The winners
 * resolve through {@link queryMapData} as one id-keyed read, so menus and
 * overrides arrive exactly as the old viewport read shipped them.
 *
 * With a {@link SearchFilter} the same read narrows to MATCHING venues before
 * the per-cell ranking, so a representative cell keeps its top-ranked MATCH
 * (not a non-matching venue that would hide it) and an empty `cells` entry
 * means "no match here" — negatively cacheable per (filter, cell) exactly like
 * browse. An empty-once-gated filter (unsearchable text, no diet) degrades to
 * the plain browse read (see {@link searchMembership}).
 *
 * The indexed bbox pre-filter is the COVER of the requested cells (their
 * bounding box, see cellsCoverBounds); the per-row cell-key test against the
 * requested set is authoritative. A scattered request therefore boxes more rows
 * than it keeps — real requests are contiguous strips (a pan's leading edge) or
 * rectangles (a fresh level), so the cover stays tight; the worst forgeable
 * case degrades to the old whole-box scan, no worse.
 */
export async function getMapCellsData(
	db: D1Like,
	level: number,
	cells: [number, number][],
	search: SearchFilter | null = null
): Promise<MapCellsData> {
	// No cells (a viewport entirely outside the data domain enumerates none):
	// nothing to ask — and the cover of an empty set would be an infinite box.
	if (cells.length === 0) return { locations: [], menus: {}, menuMeta: {}, cells: {} };
	const cellDeg = levelCell(level);
	const perCellCap = level === 0 ? FULL_CELL_CAP : REP_CELL_CAP;
	const cover = cellsCoverBounds(cells, cellDeg);
	const keys = cells.map(([i, j]) => cellKey(i, j));
	const membership = search === null ? null : searchMembership(search);

	// The lean payload caps each menu to its top {@link REP_ITEM_CAP} items, but
	// only when no free-text term is active — under text the client re-filters the
	// SHARED menu per venue (name OR item), so a cap could hide the item a branch
	// matched on (see {@link ItemCap}). The diet selector, by contrast, is a pure
	// per-item tag predicate the cap can honour: pass its closure so the kept ten
	// are the diet-matching ones. Browse (no filter at all) caps over the whole
	// menu. The cap is (filter, cell)-pure like the rest of the read, so it caches
	// identically per block.
	const hasText = search !== null && search.query !== '';
	const itemCap: ItemCap | null = hasText
		? null
		: {
				dietTagIds: search?.dietTagId ? dietFilterTagIds(search.dietTagId) : [],
				limit: REP_ITEM_CAP
			};

	// `ck` is built to be string-identical to $lib/grid's cellKey: coordinates
	// shifted non-negative (+90/+180) so the truncating CAST floors exactly like
	// the client's Math.floor, then joined with ':'. The requested keys travel as
	// ONE JSON-array bind expanded with json_each — never an `IN (?, …)` list,
	// which would blow D1's ~100 per-query bound-parameter cap at viewport-sized
	// cell sets. The membership predicate (when filtering) is AND'ed into the
	// boxed scan, so ranking only ever sees matches; its params bind between the
	// cover's and the keys', matching their position in the SQL text.
	const { results: picked } = await db
		.prepare(
			`WITH boxed AS (
				SELECT l.id AS id, l.menu_id AS menu_id, l.name AS name,
					${locationScoreSql('l.id')} AS score,
					(CAST((l.latitude + 90) / ? AS INTEGER) || ':' || CAST((l.longitude + 180) / ? AS INTEGER)) AS ck
				FROM locations l
				WHERE l.closed_at IS NULL AND l.latitude BETWEEN ? AND ? AND l.longitude BETWEEN ? AND ?
					${membership === null ? '' : `AND (${membership.cond})`}
			),
			ranked AS (
				SELECT id, ck, score,
					ROW_NUMBER() OVER (
						PARTITION BY ck
						ORDER BY (menu_id IS NOT NULL) DESC, score DESC, name, id
					) AS rn
				FROM boxed
				WHERE ck IN (SELECT value FROM json_each(?))
			)
			SELECT id, ck, score FROM ranked WHERE rn <= ? ORDER BY ck, rn`
		)
		.bind(
			cellDeg,
			cellDeg,
			cover.minLat,
			cover.maxLat,
			cover.minLng,
			cover.maxLng,
			...(membership === null ? [] : membership.params),
			JSON.stringify(keys),
			perCellCap
		)
		.all<{ id: string; ck: string; score: number }>();

	// Every requested cell is present in the result — an empty one as [] — so
	// callers can cache "known empty" rather than re-asking.
	const byCell: Record<string, string[]> = {};
	for (const key of keys) byCell[key] = [];
	for (const row of picked) byCell[row.ck]?.push(row.id);
	if (picked.length === 0) return { locations: [], menus: {}, menuMeta: {}, cells: byCell };

	// Resolve the winners (menus, overrides) the normal id-first way.
	// The ids are already capped per cell above, so the trailing LIMIT is sized
	// to pass them all through — MAP_RESULT_LIMIT would silently drop winners on
	// a full-level batch and corrupt the per-cell membership.
	// The ranking CTE above already computed every winner's score; hand it through
	// as the precomputed `score` so queryMapData skips re-running the identical
	// correlated subqueries per winner (up to a full-level batch's worth of
	// redundant index probes on every cell-cache block miss).
	const data = await queryMapData(
		db,
		`id IN (SELECT value FROM json_each(?))`,
		[JSON.stringify(picked.map((row) => row.id))],
		`ORDER BY name, id LIMIT ${picked.length}`,
		false,
		new Map(picked.map((row) => [row.id, row.score])),
		itemCap
	);
	return { ...data, cells: byCell };
}

/**
 * Like {@link getMapCellsData} but for a single location by id, returned in the same
 * {@link MapData} shape — except its items carry the FULL {@link Item} detail
 * (description, price) and its menu's sources ride on `menuMeta`. This is the
 * one read behind the detail panel, so it alone pays for the heavy fields; the
 * bulk viewport/search reads stay lean (#83). Yields an empty payload if no
 * location has that id.
 */
export function getLocationMapData(db: D1Like, id: string): Promise<MapData<Item>> {
	return queryMapData(db, `id = ?`, [id], DEFAULT_MAP_CAP, true);
}

/**
 * The search filter a cells read can carry (see {@link getMapCellsData}): the
 * same per-cell viewport read, narrowed server-side to matching venues, so an
 * active search stays cell-based — panning fetches matches for the newly
 * visible cells, cached per (filter, cell) at every layer exactly like browse.
 *
 * The single `query` is one combined free-text term matched as an OR across two
 * dimensions — the venue NAME and its item names — so one box finds both a place
 * ("Chipotle") and a dish ("burrito"):
 *   • the venue's `name` contains `query`  (→ the whole menu is relevant), OR
 *   • the venue has an item whose name contains `query`.
 * The `dietTagId` selector is a SEPARATE filter that always narrows: when set, the
 * matching item must ALSO carry that one curated dietary tag (the SAME item must
 * satisfy both name and diet), and a name-only match is kept only if the venue has
 * a diet-carrying item.
 *
 * This mirrors the client's membership (src/lib/search-match.ts) exactly so the
 * two agree (the client re-filters the rendered set while a fetch is in flight);
 * the scripts/search-parity.test.ts suite holds the two halves to identical
 * membership. Per-location overrides are not applied here (the shared menu is
 * what's searched); the client re-filters the resolved menu, so an item made
 * unavailable at one branch simply drops from that card.
 */
export interface SearchFilter {
	/** Combined free-text: matched against the venue name OR its item names. */
	query: string;
	/** A single curated dietary tag id the item must carry, or `null` for no diet filter. */
	dietTagId: string | null;
}

/**
 * The membership predicate (over the `locations` row aliased `l`) + bind params
 * for a {@link SearchFilter}, or null when the filter is EMPTY once gated —
 * unsearchable text with no diet degrades to the plain browse read, matching
 * the client, which filters such text locally and never sends it (#103/#104).
 *
 * Text matching resolves through the FTS5 trigram mirrors (locations_fts /
 * items_fts, migration 0016) using the SAME `LIKE '%q%'` patterns as a base-
 * table scan would — never MATCH — so membership stays substring-exact while
 * the trigram index takes the query from a two-table crawl to an index lookup.
 * Text the index CANNOT serve — no run of 3+ wildcard-free characters (see
 * {@link searchableQuery}) — is treated as absent rather than full-scanned.
 */
function searchMembership(filter: SearchFilter): { cond: string; params: string[] } | null {
	// Text the trigram index can't serve is treated as ABSENT (searchableQuery
	// returns ''): with a diet active the filter degrades to diet-only, without
	// one to no filter at all. Never full-scan the FTS mirrors.
	const text = searchableQuery(filter.query);
	const hasText = text !== '';
	const hasDiet = filter.dietTagId !== null;
	if (!hasText && !hasDiet) return null;

	// Both text dimensions resolve through the FTS5 trigram mirrors (migration 0016):
	// the pattern is the exact `%q%` substring LIKE as ever, but evaluated against the
	// FTS table, where the trigram index can serve it. The `ESCAPE` clause is appended
	// ONLY when the query contains a `%`/`_`/`\` that must match literally (when
	// nothing was escaped the pattern carries no `\`, so the two forms match
	// identically) — and SQLite forwards only two-argument LIKEs to a virtual table,
	// so the LIKE+ESCAPE form alone would force a full FTS scan. That form is
	// therefore prefixed with an index-served two-argument LIKE on the query's
	// longest wildcard-free run (3+ chars, guaranteed by the searchableQuery gate
	// above): the trigram index narrows to the run's matches and the ESCAPE LIKE
	// refines them, keeping wildcard-carrying queries exact AND index-accelerated
	// (a name matching the full literal text necessarily contains every run of it).
	const escapedText = escapeLikePattern(text);
	const needsEscape = escapedText !== text;
	const textCond = (col: string): string =>
		needsEscape ? `${col} LIKE ? AND ${col} LIKE ? ESCAPE '\\'` : `${col} LIKE ?`;
	const textParams: string[] = needsEscape
		? [`%${longestLiteralRun(text)}%`, `%${escapedText}%`]
		: [`%${escapedText}%`];
	// The venue-name dimension, joined back to the outer row by id. A stale
	// mirror row can only ever un-match, never invent a venue.
	const nameMatch = `l.id IN (SELECT f.id FROM locations_fts f WHERE ${textCond('f.name')})`;
	// Menus with at least one item carrying the selected diet tag, as an
	// UNCORRELATED set (driven off idx_item_tags_tag_id, computed once). Every
	// disjunct below tests `l.menu_id IN (…such a set…)` rather than a correlated
	// `EXISTS (… i.menu_id = l.menu_id …)`: the correlated form re-probes a
	// chain's SHARED menu once per branch, while the uncorrelated set is
	// materialized once per statement and probed per row. (`NULL IN (…)` is
	// never true, so a venue with no menu is excluded exactly as EXISTS would.)
	// The selected diet resolves to its implication closure (dietFilterTagIds):
	// Vegetarian / Dairy-free also match vegan-tagged items — writes strip those
	// entailed tags from vegan items, so the closure is what keeps them matching.
	const dietIds = hasDiet ? dietFilterTagIds(filter.dietTagId as string) : [];
	const dietIdList = dietIds.map(() => '?').join(', ');
	const dietMenus = `SELECT i.menu_id FROM items i JOIN item_tags it ON it.item_id = i.id WHERE it.tag_id IN (${dietIdList})`;

	// Membership is an OR of independent disjuncts, built so each disjunct's `?`
	// placeholders are pushed onto `params` in the exact left-to-right order they
	// appear in the SQL.
	const disjuncts: string[] = [];
	const params: string[] = [];

	// Name match with no diet active → the whole menu is relevant, so the venue is kept
	// even with an empty menu (no item is required).
	if (hasText && !hasDiet) {
		disjuncts.push(nameMatch);
		params.push(...textParams);
	}
	// Name match WITH a diet active → kept only if some item carries the diet tag
	// (diet always narrows), so a name-only match with no diet-matching item drops.
	if (hasText && hasDiet) {
		disjuncts.push(`(${nameMatch} AND l.menu_id IN (${dietMenus}))`);
		params.push(...textParams, ...dietIds);
	}
	// An item satisfying every active predicate: its name contains `query` (when set)
	// AND it carries the diet tag (when set). The SAME item `i` must satisfy both. The
	// text side resolves through items_fts (an uncorrelated subquery — SQLite
	// materializes it once per statement) and joins back to `items` by id, so menu
	// membership always comes from `items`, never the mirror. With text active the
	// menu set is driven off the (small) trigram match list, so the per-item diet
	// test is a cheap covering-PK probe; the text-free variant instead uses
	// `dietMenus`, whose join drives off idx_item_tags_tag_id (measurably faster
	// than scanning `items` and probing tags per row).
	if (hasText) {
		const itemConds = [`i.id IN (SELECT f.id FROM items_fts f WHERE ${textCond('f.item_name')})`];
		params.push(...textParams);
		if (hasDiet) {
			itemConds.push(
				`EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id AND it.tag_id IN (${dietIdList}))`
			);
			params.push(...dietIds);
		}
		disjuncts.push(`l.menu_id IN (SELECT i.menu_id FROM items i WHERE ${itemConds.join(' AND ')})`);
	} else {
		disjuncts.push(`l.menu_id IN (${dietMenus})`);
		params.push(...dietIds);
	}

	return { cond: disjuncts.join(' OR '), params };
}

/**
 * The default ordering+cap for {@link queryMapData}: the alphabetically-first
 * {@link MAP_RESULT_LIMIT} locations.
 */
const DEFAULT_MAP_CAP = `ORDER BY name, id LIMIT ${MAP_RESULT_LIMIT}`;

// Bayesian-average prior for the discoverability score (see locationScoreSql):
// M synthetic prior ratings at mean C star. A venue with few real ratings is
// pulled toward C, so a lone 5★ can't outrank a well-reviewed 4.6★; volume still
// dominates the score overall, so popular places rank first as they did under the
// old raw like count. PRIOR_SUM is folded (M×C) to keep the SQL a plain literal.
const SCORE_PRIOR_COUNT = 5;
const SCORE_PRIOR_SUM = 17.5; // M × C, C = 3.5

/**
 * The opaque per-LOCATION importance `score` the map's label declutter ranks by,
 * as a SQL scalar expression over a location-id column (migration 0029 — replaces
 * the old raw like count). Three additive, integer-valued terms:
 *   • rating VOLUME (count × 100) — dominates, mirroring the old like-count spirit;
 *   • rating QUALITY — a Bayesian average star (×20) nudges within a volume tier;
 *   • BOOKMARK count (× 10) — a weak popularity floor so the map is populated even
 *     before ratings accrue.
 * Hidden reviews are excluded (moderation drops the row from the aggregate too).
 * `col` is the SQL for the location id in the enclosing query (`locations.id`, `l.id`).
 */
function locationScoreSql(col: string): string {
	return (
		`((SELECT COUNT(*) * 100 + CAST((COALESCE(SUM(rating), 0) + ${SCORE_PRIOR_SUM})` +
		` / (COUNT(*) + ${SCORE_PRIOR_COUNT}.0) * 20 AS INTEGER)` +
		` FROM location_reviews r WHERE r.location_id = ${col} AND r.hidden_at IS NULL)` +
		` + (SELECT COUNT(*) * 10 FROM location_bookmarks b WHERE b.location_id = ${col}))`
	);
}

/** Item counterpart of {@link locationScoreSql}: ranks items within a menu by
 *  rating volume + Bayesian quality + bookmark count (replaces the old like count). */
function itemScoreSql(col: string): string {
	return (
		`((SELECT COUNT(*) * 100 + CAST((COALESCE(SUM(rating), 0) + ${SCORE_PRIOR_SUM})` +
		` / (COUNT(*) + ${SCORE_PRIOR_COUNT}.0) * 20 AS INTEGER)` +
		` FROM item_reviews r WHERE r.item_id = ${col} AND r.hidden_at IS NULL)` +
		` + (SELECT COUNT(*) * 10 FROM item_bookmarks b WHERE b.item_id = ${col}))`
	);
}

/**
 * Shared implementation of {@link getMapCellsData} / {@link getLocationMapData}.
 * `locFilter` is a predicate over the `locations` table
 * (its `?` placeholders bound from the front of `params`); `capClause` is the
 * trailing `ORDER BY … LIMIT …` that both bounds and orders the location set,
 * any `?` placeholders it carries bound from the END of
 * `params`, AFTER the `locFilter` ones.
 *
 * The filter is evaluated EXACTLY ONCE — the main row read. Every sub-row read
 * is keyed by the location/menu ids that read returned (one JSON-array bind
 * each), and the whole set of sub-reads travels as a single `db.batch()`. Both
 * halves of that shape matter at scale:
 *   • an expensive `locFilter` (the search disjuncts, a viewport box) is never
 *     re-evaluated per sub-read — it used to be spliced into every statement as
 *     a nested subquery, multiplying its cost by the statement count;
 *   • the batch is one D1 round trip instead of seven, executed as one atomic
 *     unit, so the sub-reads also see a single consistent snapshot rather than
 *     independently-raced reads.
 *
 * `detail` picks the item shape (#83): false (the bulk viewport/search reads)
 * projects only the lean {@link MapItem} columns and skips the menu-source read
 * entirely — the map UI never renders those fields; true (the single-venue
 * by-id read behind the detail panel) returns full {@link Item}s with
 * description and price, plus each menu's sources on `menuMeta`.
 */
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[],
	capClause: string,
	detail: true
): Promise<MapData<Item>>;
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[],
	capClause?: string,
	detail?: false,
	scores?: Map<string, number>,
	itemCap?: ItemCap | null
): Promise<MapData>;
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[],
	capClause: string = DEFAULT_MAP_CAP,
	detail: boolean = false,
	scores?: Map<string, number>,
	itemCap: ItemCap | null = null
): Promise<MapData> {
	// The one evaluation of `locFilter`: the capped, `capClause`-ordered location
	// rows themselves. `closed_at IS NULL` hides soft-deleted (permanently-closed)
	// venues from every map/detail/search read this powers (migration 0015). It
	// carries no bind param, so the `.bind(...params)` alignment is untouched.
	// `score` is the discoverability score (locationScoreSql — rating volume +
	// Bayesian quality + bookmark weight), already at its opaque wire name so no
	// later step renames it. When the caller already computed the scores
	// (getMapCellsData's ranking CTE probes them per candidate — `scores`), they
	// attach in JS below; otherwise it's a correlated index probe per returned
	// row (bounded by the cap, same shape as that ranking term).
	const scoreSelect = scores === undefined ? `, ${locationScoreSql('locations.id')} AS score` : '';
	const { results: locations } = await db
		.prepare(
			`SELECT ${LOCATION_FIELDS}${scoreSelect}
			 FROM locations WHERE closed_at IS NULL AND (${locFilter}) ${capClause}`
		)
		.bind(...params)
		.all<LocationRow & { score: number }>();
	if (locations.length === 0) return { locations: [], menus: {}, menuMeta: {} };

	// Everything else is scoped by the materialized ids: the returned locations,
	// the menus they reference, and the items on those menus. Each id set is ONE
	// JSON-array bind expanded with json_each — never an `IN (?, …)` list, which
	// would blow D1's ~100 per-query bound-parameter cap at MAP_RESULT_LIMIT-sized
	// result sets.
	const locationIds = JSON.stringify(locations.map((l) => l.id));
	const menuIds = JSON.stringify([
		...new Set(locations.map((l) => l.menu_id).filter((m): m is string => m !== null))
	]);
	const inLocations = `SELECT value FROM json_each(?)`;
	const inMenus = `SELECT value FROM json_each(?)`;
	const inItems = `SELECT id FROM items WHERE menu_id IN (SELECT value FROM json_each(?))`;

	// The item read. Uncapped by default (the by-id detail read wants the whole
	// menu; so does any lean read with no cap): every item of the referenced
	// menus, ordered by name. With an {@link ItemCap} (the lean viewport/search
	// path) it instead keeps each menu's top `limit` items — filtered to the diet
	// closure when set, then ranked by item score (desc, name/id to break
	// ties deterministically so the cut is order-stable and cache-pure) — and
	// carries each menu's pre-cut match count through `COUNT(*) OVER` so the
	// caller can surface "N of `limit`". `match_count` is identical on every row
	// of a menu; the assembly below reads it once per menu.
	const itemStatement =
		itemCap === null
			? db
					.prepare(
						`SELECT ${detail ? ITEM_FIELDS : MAP_ITEM_FIELDS} FROM items WHERE menu_id IN (${inMenus}) ORDER BY menu_id, item_name`
					)
					.bind(menuIds)
			: db
					.prepare(
						`WITH matched AS (
							SELECT i.id AS id, i.menu_id AS menu_id, i.item_name AS item_name,
								${itemScoreSql('i.id')} AS iscore
							FROM items i
							WHERE i.menu_id IN (${inMenus})${
								itemCap.dietTagIds.length === 0
									? ''
									: ` AND i.id IN (SELECT item_id FROM item_tags WHERE tag_id IN (${itemCap.dietTagIds
											.map(() => '?')
											.join(', ')}))`
							}
						),
						ranked AS (
							SELECT id, menu_id, item_name,
								ROW_NUMBER() OVER (PARTITION BY menu_id ORDER BY iscore DESC, item_name, id) AS irn,
								COUNT(*) OVER (PARTITION BY menu_id) AS match_count
							FROM matched
						)
						SELECT id, menu_id, item_name, match_count FROM ranked WHERE irn <= ? ORDER BY menu_id, irn`
					)
					.bind(menuIds, ...itemCap.dietTagIds, itemCap.limit);

	// The tuple cast mirrors each statement's projection 1:1 — `batch` itself is
	// typed `unknown[]` on D1Like because the two backends (Worker binding,
	// d1-http shim) type their per-statement results differently, though both
	// return `{ results }` objects in statement order. The menu-source read runs
	// only in detail mode (sources are surfaced in the ONE open venue's panel, not
	// on the lean map payload), appended after the fixed core statements so the
	// destructuring holds in both modes — its slot is simply absent on a lean read.
	const coreStatements = [
		itemStatement,
		db
			.prepare(`SELECT id, currency, last_verified FROM menus WHERE id IN (${inMenus})`)
			.bind(menuIds),
		// Tag edges: the lean read projects only (tag_id, optional) straight off
		// `item_tags` — no join to `tags` and no name/tag_type on the wire (the
		// closed vocabulary is bundled client-side; see MapItemTag). The detail
		// read keeps the full self-describing shape. Both order by the vocabulary
		// (tags.rowid) so an item's tags list identically in either mode; the lean
		// statement keeps the join for that ordering but ships none of its columns.
		db
			.prepare(
				`SELECT it.item_id AS owner_id, ${detail ? ITEM_TAG_SELECT : MAP_ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 WHERE it.item_id IN (${inItems})
				 ORDER BY t.rowid`
			)
			.bind(menuIds),
		db
			.prepare(
				`SELECT location_id, item_id, available, price FROM location_item_overrides
				 WHERE location_id IN (${inLocations}) ORDER BY rowid`
			)
			.bind(locationIds)
	];
	const detailStatements = detail
		? [
				db
					.prepare(
						`SELECT menu_id AS owner_id, url, label FROM menu_sources
						 WHERE menu_id IN (${inMenus}) ORDER BY rowid`
					)
					.bind(menuIds)
			]
		: [];
	const [
		{ results: itemRows },
		{ results: menuCurrencyRows },
		{ results: itemTagRows },
		{ results: overrideRows },
		menuSourceRes
	] = (await db.batch([...coreStatements, ...detailStatements])) as [
		{ results: (ItemRow & { match_count?: number })[] },
		{
			results: { id: string; currency: string; last_verified: string | null }[];
		},
		{ results: ItemTagRow[] },
		{ results: OverrideRow[] },
		{ results: SourceRow[] }?
	];

	// Resolve each menu item once (tags) and group by menu. The client applies the
	// per-location price/availability deltas as it expands a menu onto each branch.
	// Menu-level sources (detail mode only) ride on `menuMeta` per menu, not per item.
	// The tag rows are the shape the statement above projected: full ItemTagRows in
	// detail mode, lean MapItemTagRows otherwise (name/tag_type undefined at runtime
	// there, same convention as ItemRow's lean columns).
	const tagsByItem = detail ? groupItemTags(itemTagRows) : groupMapItemTags(itemTagRows);
	const sourcesByMenu = groupSources(menuSourceRes?.results ?? []);
	const currencyByMenu = new Map(menuCurrencyRows.map((r) => [r.id, r.currency]));
	// Per-menu pre-cut match count (item-capped reads only): every row of a menu
	// carries the same `COUNT(*) OVER` total, so the first one seen wins. A menu
	// with zero matching items ships no item rows, so it defaults to 0 below.
	const matchCountByMenu = new Map<string, number>();
	if (itemCap !== null) {
		for (const row of itemRows) {
			if (row.match_count !== undefined && !matchCountByMenu.has(row.menu_id)) {
				matchCountByMenu.set(row.menu_id, row.match_count);
			}
		}
	}
	const menuMeta: MapData['menuMeta'] = {};
	for (const row of menuCurrencyRows) {
		menuMeta[row.id] = {
			last_verified: row.last_verified,
			sources: sourcesByMenu.get(row.id) ?? [],
			...(itemCap === null ? {} : { matchingItemCount: matchCountByMenu.get(row.id) ?? 0 })
		};
	}

	const menus: Record<string, MapItem[]> = {};
	for (const row of itemRows) {
		const lean: MapItem = {
			id: row.id,
			menu_id: row.menu_id,
			item_name: row.item_name,
			tags: tagsByItem.get(row.id) ?? []
		};
		// The cast on `tags` is sound: in detail mode tagsByItem came from
		// groupItemTags, so the edges really are full ItemTags.
		const full: Item | null = detail
			? {
					...lean,
					tags: lean.tags as ItemTag[],
					description: row.description,
					price: row.price,
					currency: currencyByMenu.get(row.menu_id) ?? DEFAULT_CURRENCY
				}
			: null;
		(menus[row.menu_id] ??= []).push(full ?? lean);
	}

	// Overrides grouped by location, with `available` as the public boolean|null.
	const overridesByLocation = new Map<string, LocationItemOverride[]>();
	for (const row of overrideRows) {
		const list = overridesByLocation.get(row.location_id) ?? [];
		list.push({
			location_id: row.location_id,
			item_id: row.item_id,
			available: row.available === null ? null : row.available !== 0,
			price: row.price
		});
		overridesByLocation.set(row.location_id, list);
	}

	// A precomputed `score` attaches here instead of via the SQL subquery; the
	// explicit key sits where the projected column would, so the payload shape
	// (including key order) is identical on both paths.
	const mapLocations: MapLocation[] = locations.map((loc) => ({
		...loc,
		score: scores === undefined ? loc.score : (scores.get(loc.id) ?? 0),
		address: formatAddress(loc),
		overrides: overridesByLocation.get(loc.id) ?? []
	}));

	return { locations: mapLocations, menus, menuMeta };
}

/** The identity fields the `/locations/<id>` gate needs to build the canonical
 *  descriptive URL: the id (echoed back), plus the name and city that fold into
 *  the slug prefix (see `locationSlug` in $lib/location-path), and whether the
 *  venue is closed (soft-deleted) so the gate can tell a permanent closure apart
 *  from an unknown id (410 vs 404). */
export interface LocationSlugFields {
	id: string;
	name: string;
	city: string;
	/** True when the venue is soft-deleted (`closed_at` set — migration 0015). */
	closed: boolean;
}

/**
 * The slug fields of a location that EXISTS (open or closed), or null when no
 * row bears the id. Backs the map page's `/locations/<…>` gate
 * (src/routes/+page.server.ts), which runs on every hard load of a venue URL: it
 * reads only the columns needed to (a) prove the venue exists — null means a 404
 * for an unknown id — (b) tell a verified closure apart from that unknown id so
 * the gate can serve 410 Gone for a soft-deleted venue (dropping it from the
 * index faster than a 404), and (c) recompute the canonical `<name>-<city>-<uuid>`
 * path so a bare or wrong-slug URL for an OPEN venue can 301 to it, rather than
 * paying {@link getLocationById}'s full row read. Unlike every DISPLAY read
 * (which excludes closed venues — migration 0015), this returns the closed row
 * too, distinguished by its `closed` flag, precisely so the gate can 410 it.
 */
export async function getLocationSlugFields(
	db: D1Like,
	id: string
): Promise<LocationSlugFields | null> {
	const row = await db
		.prepare(`SELECT id, name, city, closed_at FROM locations WHERE id = ?`)
		.bind(id)
		.first<{ id: string; name: string; city: string; closed_at: number | null }>();
	if (!row) return null;
	return { id: row.id, name: row.name, city: row.city, closed: row.closed_at !== null };
}

/**
 * The lean projection behind `/sitemap.xml`: every open venue's id plus the
 * `name`/`city` that build its canonical descriptive slug (see
 * {@link SitemapEntry}), and its menu's `last_verified` date — the honest
 * `<lastmod>` signal, since the menu IS the page's substance, so the date it was
 * last checked against its source is when the page last meaningfully changed
 * (NULL for a venue without a menu yet). Closed (soft-deleted) venues are
 * excluded: their pages are hidden from the map (migration 0015), so listing
 * them would only hand crawlers soft-404s. LIMIT 250000 is a Worker-memory
 * bound, not a protocol one: the sitemap index (src/routes/sitemap.xml) pages
 * past the protocol's 50k-per-file cap, but sitemap-cache.ts holds the whole
 * result as one in-memory array — at ~200 B per entry that's tens of MB at this
 * cap. Growing past it means per-page keyset-paginated reads instead of one
 * cached full read.
 */
export async function getSitemapEntries(db: D1Like): Promise<SitemapEntry[]> {
	const { results } = await db
		.prepare(
			`SELECT l.id AS id, l.name AS name, l.city AS city, m.last_verified AS last_verified
			 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
			 WHERE l.closed_at IS NULL
			 ORDER BY l.id
			 LIMIT 250000`
		)
		.all<SitemapEntry>();
	return results;
}

/** Aggregate coverage totals for the public landing overlay (see {@link getStats}). */
export interface MapStats {
	/** Total food locations on the map. */
	locations: number;
	/** Total menu items captured (a shared chain menu's items counted once). */
	items: number;
	/** Distinct cities covered, keyed by city + region + country so same-named
	 *  cities in different provinces/countries aren't merged. */
	cities: number;
	/** Per-dietary-tag dish counts, keyed by dietary tag id (`vegan`, `halal`, …).
	 *  Each is the number of distinct items the map's diet selector would surface
	 *  for that diet — counted through the SAME implication closure the filter uses
	 *  ({@link dietFilterTagIds}), so e.g. `vegetarian` includes vegan dishes. */
	diets: Record<string, number>;
}

/**
 * Coverage totals shown on the zoomed-out landing overlay: how much data we've
 * collected. One round-trip via correlated scalar subqueries — the location/city
 * counts plus one distinct-item count per dietary tag. Safe to expose without
 * auth: it returns only counts, never any row data.
 */
export async function getStats(db: D1Like): Promise<MapStats> {
	// One column per dietary tag, each counting the items the diet selector would
	// surface for it: distinct items carrying ANY tag in that diet's implication
	// closure (dietFilterTagIds), so the headline matches the filter (a vegan dish
	// counts under Vegetarian and Dairy-free too). Tag ids are the fixed app
	// vocabulary (not user input), but bound as params rather than interpolated.
	// The idx_item_tags_tag_id index keeps each subquery an index range scan.
	const dietTagIds = TAGS.filter((t) => t.tag_type === 'dietary').map((t) => t.id);
	const dietBinds: string[] = [];
	const dietCols = dietTagIds.map((id) => {
		const closure = dietFilterTagIds(id);
		dietBinds.push(...closure);
		const placeholders = closure.map(() => '?').join(', ');
		return `(SELECT COUNT(DISTINCT item_id) FROM item_tags WHERE tag_id IN (${placeholders})) AS "${id}"`;
	});

	const row = await db
		.prepare(
			// Closed (soft-deleted) venues are excluded so coverage totals reflect the live map
			// (migration 0015). Item count is menu-level and left as-is.
			`SELECT
				(SELECT COUNT(*) FROM locations WHERE closed_at IS NULL) AS locations,
				(SELECT COUNT(*) FROM items) AS items,
				(SELECT COUNT(DISTINCT city || '|' || region || '|' || country) FROM locations WHERE closed_at IS NULL) AS cities,
				${dietCols.join(',\n\t\t\t\t')}`
		)
		.bind(...dietBinds)
		.first<Record<string, number>>();

	const diets: Record<string, number> = {};
	for (const id of dietTagIds) diets[id] = row?.[id] ?? 0;
	return {
		locations: row?.locations ?? 0,
		items: row?.items ?? 0,
		cities: row?.cities ?? 0,
		diets
	};
}

// ---------------------------------------------------------------------------
// Geographic browse pages (src/routes/[country]/…): the crawlable index tree
// (#217) that turns the sitemap's orphan venue pages into an interlinked graph
// and creates city+diet landing surfaces. Every read excludes closed venues
// (migration 0015), matching the map. The aggregate GROUP BY reads here run
// bounded scans; the routes cache their responses (Cache-Control), so they don't
// run per visitor.
// ---------------------------------------------------------------------------

/** One bucket of a browse index: a country code, region code, or city name,
 *  with its open-venue count. */
export interface BrowseGroup {
	value: string;
	count: number;
}

/** Countries with open venues, most-covered first — the `/places` index. */
export async function getBrowseCountries(db: D1Like): Promise<BrowseGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT country AS value, COUNT(*) AS count FROM locations
			 WHERE closed_at IS NULL GROUP BY country ORDER BY count DESC, country`
		)
		.all<BrowseGroup>();
	return results;
}

/** Regions (provinces/states) with open venues in a country, most-covered first. */
export async function getBrowseRegions(db: D1Like, country: string): Promise<BrowseGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT region AS value, COUNT(*) AS count FROM locations
			 WHERE closed_at IS NULL AND country = ? GROUP BY region ORDER BY count DESC, region`
		)
		.bind(country)
		.all<BrowseGroup>();
	return results;
}

/** Cities with open venues in a region, most-covered first. Also how a city URL
 *  slug is resolved back to its real name(s): the route slugifies each `value`
 *  and keeps the matches (the slug is lossy, so more than one city can share one). */
export async function getBrowseCities(
	db: D1Like,
	country: string,
	region: string
): Promise<BrowseGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT city AS value, COUNT(*) AS count FROM locations
			 WHERE closed_at IS NULL AND country = ? AND region = ?
			 GROUP BY city ORDER BY count DESC, city`
		)
		.bind(country, region)
		.all<BrowseGroup>();
	return results;
}

/** A venue row for a browse listing: the fields to render a link (name + address)
 *  and to build its canonical `/locations/<slug>` href (id + name + city). */
export interface BrowseVenue {
	id: string;
	name: string;
	category: Category | null;
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
	/** Single-line display address, derived on read (see {@link formatAddress}). */
	address: string;
}

const BROWSE_VENUE_COLS = [
	'id',
	'name',
	'category',
	'street',
	'city',
	'region',
	'postcode',
	'country'
];

/** Hard cap on a browse listing's venue rows — a bound on payload/DOM size for a
 *  huge city, not a real limit today (the largest city is a few hundred). The
 *  route flags when a page hits it. */
export const BROWSE_VENUE_LIMIT = 2000;

function toBrowseVenue(row: Omit<BrowseVenue, 'address'>): BrowseVenue {
	return { ...row, address: formatAddress(row) };
}

/** Open venues in the given cities (already resolved from a URL slug to real
 *  names), name-sorted, capped at {@link BROWSE_VENUE_LIMIT} — a city's page. */
export async function getBrowseVenues(
	db: D1Like,
	country: string,
	region: string,
	cities: string[],
	limit = BROWSE_VENUE_LIMIT
): Promise<BrowseVenue[]> {
	if (cities.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT ${BROWSE_VENUE_COLS.join(', ')} FROM locations
			 WHERE closed_at IS NULL AND country = ? AND region = ?
			   AND city IN (SELECT value FROM json_each(?))
			 ORDER BY name, id LIMIT ?`
		)
		.bind(country, region, JSON.stringify(cities), limit)
		.all<Omit<BrowseVenue, 'address'>>();
	return results.map(toBrowseVenue);
}

/**
 * Open venues in the given cities that serve at least one item carrying one of
 * `tagIds` — a city+diet page. `tagIds` is the diet's satisfying set (the diet
 * plus any tag entailing it, via `dietFilterTagIds`), so the page matches the
 * map's diet filter. An EXISTS subquery (not a DISTINCT join) keeps it one row
 * per venue; `optional` tags count, matching the map filter's optional-agnostic
 * membership.
 */
export async function getBrowseVenuesByDiet(
	db: D1Like,
	country: string,
	region: string,
	cities: string[],
	tagIds: string[],
	limit = BROWSE_VENUE_LIMIT
): Promise<BrowseVenue[]> {
	if (cities.length === 0 || tagIds.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT ${BROWSE_VENUE_COLS.map((c) => `l.${c}`).join(', ')} FROM locations l
			 WHERE l.closed_at IS NULL AND l.country = ? AND l.region = ?
			   AND l.city IN (SELECT value FROM json_each(?))
			   AND EXISTS (
			     SELECT 1 FROM items i JOIN item_tags it ON it.item_id = i.id
			     WHERE i.menu_id = l.menu_id AND it.tag_id IN (SELECT value FROM json_each(?))
			   )
			 ORDER BY l.name, l.id LIMIT ?`
		)
		.bind(country, region, JSON.stringify(cities), JSON.stringify(tagIds), limit)
		.all<Omit<BrowseVenue, 'address'>>();
	return results.map(toBrowseVenue);
}

/** The distinct DIETARY tag ids present across a city's open venues — drives the
 *  city page's per-diet cross-links (a diet is offered here if any of its
 *  satisfying tags appears). Course tags are excluded via the `tags` join. */
export async function getCityDietaryTags(
	db: D1Like,
	country: string,
	region: string,
	cities: string[]
): Promise<Set<string>> {
	if (cities.length === 0) return new Set();
	const { results } = await db
		.prepare(
			`SELECT DISTINCT it.tag_id AS tag_id FROM locations l
			 JOIN items i ON i.menu_id = l.menu_id
			 JOIN item_tags it ON it.item_id = i.id
			 JOIN tags t ON t.id = it.tag_id AND t.tag_type = 'dietary'
			 WHERE l.closed_at IS NULL AND l.country = ? AND l.region = ?
			   AND l.city IN (SELECT value FROM json_each(?))`
		)
		.bind(country, region, JSON.stringify(cities))
		.all<{ tag_id: string }>();
	return new Set(results.map((r) => r.tag_id));
}

// ---------------------------------------------------------------------------
// Users, sessions and likes (the user-owned data added by migration 0007; the
// dietary profile added by 0013). Unlike everything above — curated map data written by the MCP
// tooling — these rows are written by the deployed app at runtime. The functions
// stay runtime-agnostic (a `D1Like` handle in, async out) like the rest of this
// module; the crypto/cookie glue lives in src/lib/server/auth.ts. Timestamps are
// Unix milliseconds, supplied by the caller (`now`) so this layer reads no clock.
// ---------------------------------------------------------------------------

/** A signed-in person (mirrors the Google ID-token profile claims). */
export interface User {
	id: string;
	email: string | null;
	email_verified: boolean;
	name: string | null;
	picture: string | null;
}

/** An active login. `id` is the SHA-256 hash of the cookie token (see auth.ts). */
export interface Session {
	id: string;
	user_id: string;
	/** Expiry as Unix milliseconds. */
	expires_at: number;
}

/** The ids a user has bookmarked (saved), newest first. */
export interface UserBookmarks {
	locationIds: string[];
	itemIds: string[];
}

/** Which family of tables a bookmark/review/report targets. */
export type ReviewTarget = 'location' | 'item';

/**
 * A user's own rating value per target id (their private stars), keyed by target.
 * Shown as "your N★" on the map/menu and used to pre-fill the review editor.
 */
export interface ViewerRatings {
	locations: Record<string, number>;
	items: Record<string, number>;
}

/** One publicly-attributed review (has text, not hidden), with its author's profile. */
export interface PublicReview {
	id: string;
	rating: number;
	body: string;
	created_at: number;
	author_name: string | null;
	author_picture: string | null;
}

/** The viewer's OWN review of a target (any state — bare rating, hidden, or public). */
export interface OwnReview {
	id: string;
	rating: number;
	body: string | null;
	created_at: number;
	updated_at: number;
	hidden_at: number | null;
}

/** The reviews payload for one open venue/item: aggregate + a page of public reviews. */
export interface VenueReviews {
	/** Over all non-hidden reviews (bare ratings included). */
	summary: { count: number; average: number };
	/** Public reviews (text, not hidden), newest first, excluding the viewer's own. */
	reviews: PublicReview[];
	/** The viewer's own review, surfaced separately so the editor pre-fills. */
	own: OwnReview | null;
	/** Keyset cursor for the next page, or null when exhausted. */
	nextCursor: string | null;
}

/** One row of the moderation queue (reported or hidden reviews). */
export interface ModerationReview {
	id: string;
	target_name: string;
	rating: number;
	body: string | null;
	created_at: number;
	hidden_at: number | null;
	hidden_reason: string | null;
	author_name: string | null;
	report_count: number;
}

/** SQL table/column names per target. Fixed internal vocabulary (never user input),
 *  so interpolating these into query text is safe. */
const REVIEW_TABLES = {
	location: {
		reviews: 'location_reviews',
		bookmarks: 'location_bookmarks',
		reports: 'location_review_reports',
		targets: 'locations',
		nameCol: 'name',
		col: 'location_id'
	},
	item: {
		reviews: 'item_reviews',
		bookmarks: 'item_bookmarks',
		reports: 'item_review_reports',
		targets: 'items',
		nameCol: 'item_name',
		col: 'item_id'
	}
} as const;

/** How many distinct users must report a review before it auto-hides. */
export const REVIEW_AUTO_HIDE_THRESHOLD = 3;

/** The Google profile fields stored on a user, refreshed on each sign-in. */
export interface OAuthProfile {
	email: string | null;
	email_verified: boolean;
	name: string | null;
	picture: string | null;
}

/** Raw `users` row (`email_verified` stored as 0/1). */
interface UserRow {
	id: string;
	email: string | null;
	email_verified: number;
	name: string | null;
	picture: string | null;
}

function toUser(row: UserRow): User {
	return {
		id: row.id,
		email: row.email,
		email_verified: row.email_verified !== 0,
		name: row.name,
		picture: row.picture
	};
}

/** Looks up a user by id, or null. Used by the app auth-code exchange
 *  ($lib/server/app-auth) to load the user a redeemed code points at, so the
 *  `/api/v1/auth/token` response can echo the signed-in profile. */
export async function getUserById(db: D1Like, id: string): Promise<User | null> {
	const row = await db
		.prepare(`SELECT id, email, email_verified, name, picture FROM users WHERE id = ?`)
		.bind(id)
		.first<UserRow>();
	return row ? toUser(row) : null;
}

/** Looks up the user behind a provider identity (e.g. a Google `sub`), or null. */
export async function getUserByOAuth(
	db: D1Like,
	provider: string,
	providerUserId: string
): Promise<User | null> {
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.email_verified, u.name, u.picture
			 FROM oauth_accounts a JOIN users u ON u.id = a.user_id
			 WHERE a.provider = ? AND a.provider_user_id = ?`
		)
		.bind(provider, providerUserId)
		.first<UserRow>();
	return row ? toUser(row) : null;
}

/**
 * Resolves the user for a provider identity, creating one on first sign-in.
 * Either way the stored profile is refreshed from the latest claims, so a renamed
 * or re-pictured Google account stays in sync. Returns the up-to-date {@link User}.
 */
export async function upsertOAuthUser(
	db: D1Like,
	provider: string,
	providerUserId: string,
	profile: OAuthProfile,
	now: number
): Promise<User> {
	const verified = profile.email_verified ? 1 : 0;
	// Only persist an email the provider has verified: Google issues id tokens
	// with `email_verified: false` whose `email` claim the account holder may
	// never have proven owning, so storing it would poison any future
	// email-keyed feature. Applied on every sign-in, so a returning user whose
	// token flips to unverified has the stale stored email nulled too.
	const email = profile.email_verified ? profile.email : null;
	const existing = await getUserByOAuth(db, provider, providerUserId);
	if (existing) {
		await db
			.prepare(`UPDATE users SET email = ?, email_verified = ?, name = ?, picture = ? WHERE id = ?`)
			.bind(email, verified, profile.name, profile.picture, existing.id)
			.run();
		return { ...existing, ...profile, email };
	}
	const id = crypto.randomUUID();
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO users (id, email, email_verified, name, picture, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(id, email, verified, profile.name, profile.picture, now),
			db
				.prepare(
					`INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at)
					 VALUES (?, ?, ?, ?)`
				)
				.bind(provider, providerUserId, id, now)
		]);
	} catch (err) {
		// Lost a race with a concurrent first sign-in for the same account: the
		// oauth_accounts PK insert conflicted and the batch rolled back atomically
		// (so no orphan user row). Fall back to the user the winning request created.
		const raced = await getUserByOAuth(db, provider, providerUserId);
		if (!raced) throw err;
		return raced;
	}
	return { id, ...profile, email };
}

export async function createSession(
	db: D1Like,
	sessionId: string,
	userId: string,
	expiresAt: number,
	now: number
): Promise<Session> {
	await db
		.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
		.bind(sessionId, userId, expiresAt, now)
		.run();
	return { id: sessionId, user_id: userId, expires_at: expiresAt };
}

/**
 * Loads a session and its user in one read (the per-request auth lookup), or null.
 * The user's saved UI locale (migration 0024) is folded in via a LEFT JOIN so the
 * request-path locale resolution (resolveLocale in hooks.server.ts) reads it from
 * this one memoized lookup instead of issuing its own D1 round trip — `locale` is
 * null when the user has never saved one. The raw stored value is returned as-is
 * (typed `string | null`); the caller validates it to a supported locale with
 * `isLocale`, exactly as `getUserDiet`'s value is sanitized by its caller.
 */
export async function getSessionWithUser(
	db: D1Like,
	sessionId: string
): Promise<{ session: Session; user: User; locale: string | null } | null> {
	const row = await db
		.prepare(
			`SELECT s.id AS session_id, s.user_id AS user_id, s.expires_at AS expires_at,
				u.email AS email, u.email_verified AS email_verified, u.name AS name, u.picture AS picture,
				l.locale AS locale
			 FROM sessions s
			 JOIN users u ON u.id = s.user_id
			 LEFT JOIN user_locale l ON l.user_id = s.user_id
			 WHERE s.id = ?`
		)
		.bind(sessionId)
		.first<{
			session_id: string;
			user_id: string;
			expires_at: number;
			email: string | null;
			email_verified: number;
			name: string | null;
			picture: string | null;
			locale: string | null;
		}>();
	if (!row) return null;
	return {
		session: {
			id: row.session_id,
			user_id: row.user_id,
			expires_at: row.expires_at
		},
		user: toUser({
			id: row.user_id,
			email: row.email,
			email_verified: row.email_verified,
			name: row.name,
			picture: row.picture
		}),
		locale: row.locale ?? null
	};
}

export async function updateSessionExpiry(
	db: D1Like,
	sessionId: string,
	expiresAt: number
): Promise<void> {
	await db
		.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
		.bind(expiresAt, sessionId)
		.run();
}

export async function deleteSession(db: D1Like, sessionId: string): Promise<void> {
	await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

/**
 * Deletes every session whose expiry has passed. The lazy cleanup in
 * validateSessionToken removes an expired row only when that same cookie token
 * comes back, so sessions of users who never return would accumulate forever —
 * this sweep (fired opportunistically from the auth hook) catches them. Uses
 * the same boundary as validateSessionToken (`now >= expires_at` is expired),
 * so a row with expires_at exactly equal to `now` is deleted.
 */
export async function deleteExpiredSessions(db: D1Like, now: number): Promise<void> {
	await db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now).run();
}

// ---------------------------------------------------------------------------
// App OAuth one-time codes (migration 0026) — the mobile-app sign-in hand-off.
//
// Google blocks OAuth inside a WebView, so the app opens the SYSTEM browser at
// the normal /auth/login/google flow (marked ?client=app); the callback, instead
// of setting a browser session cookie the app can't read, mints a short-lived
// one-time CODE and redirects to a custom scheme the app intercepts. The app then
// exchanges that code for a session token at POST /api/v1/auth/token. Like the
// session token, only the code's SHA-256 is stored here — the raw code lives only
// in the redirect URL — so a leak of this table can't be replayed. See
// $lib/server/app-auth for the hashing + single-use redemption on top of these.
// ---------------------------------------------------------------------------

/** Stores a one-time app auth code (its SHA-256 hash only) for a user. */
export async function insertAppAuthCode(
	db: D1Like,
	codeHash: string,
	userId: string,
	now: number,
	expiresAt: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_auth_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
		)
		.bind(codeHash, userId, now, expiresAt)
		.run();
}

/**
 * Atomically consumes a one-time app auth code: deletes the row for `codeHash`
 * and returns what it held (`user_id`, `expires_at`), or null when no such row
 * exists. The DELETE … RETURNING is the single-use guard — a replay of the same
 * code finds the row already gone and gets null, with no time-of-check/
 * time-of-use window — so the caller need only reject an expired `expires_at`
 * (the row is consumed either way, which is correct: an expired code is spent).
 */
export async function redeemAppAuthCode(
	db: D1Like,
	codeHash: string
): Promise<{ userId: string; expiresAt: number } | null> {
	const row = await db
		.prepare(`DELETE FROM app_auth_codes WHERE code_hash = ? RETURNING user_id, expires_at`)
		.bind(codeHash)
		.first<{ user_id: string; expires_at: number }>();
	return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
}

/** Deletes every app auth code whose expiry has passed (opportunistic cleanup,
 *  fired from the token-exchange endpoint — the codes are short-lived and
 *  single-use, so leftover expired rows are just unredeemed abandoned sign-ins). */
export async function deleteExpiredAppAuthCodes(db: D1Like, now: number): Promise<void> {
	await db.prepare(`DELETE FROM app_auth_codes WHERE expires_at <= ?`).bind(now).run();
}

// ── Bookmarks ────────────────────────────────────────────────────────────────

/** Returns a user's bookmarked (saved) location and item ids, newest first. */
export async function getUserBookmarks(db: D1Like, userId: string): Promise<UserBookmarks> {
	const [{ results: locs }, { results: items }] = await Promise.all([
		db
			.prepare(
				`SELECT location_id FROM location_bookmarks WHERE user_id = ? ORDER BY created_at DESC`
			)
			.bind(userId)
			.all<{ location_id: string }>(),
		db
			.prepare(`SELECT item_id FROM item_bookmarks WHERE user_id = ? ORDER BY created_at DESC`)
			.bind(userId)
			.all<{ item_id: string }>()
	]);
	return {
		locationIds: locs.map((r) => r.location_id),
		itemIds: items.map((r) => r.item_id)
	};
}

/** Bookmarks (or, when `on` is false, un-bookmarks) a target for a user. Idempotent. */
export async function setBookmark(
	db: D1Like,
	target: ReviewTarget,
	userId: string,
	targetId: string,
	on: boolean,
	now: number
): Promise<void> {
	const t = REVIEW_TABLES[target];
	if (on) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO ${t.bookmarks} (user_id, ${t.col}, created_at) VALUES (?, ?, ?)`
			)
			.bind(userId, targetId, now)
			.run();
	} else {
		await db
			.prepare(`DELETE FROM ${t.bookmarks} WHERE user_id = ? AND ${t.col} = ?`)
			.bind(userId, targetId)
			.run();
	}
}

// ── Reviews (rating + optional text) ─────────────────────────────────────────

/** The current user's own rating per target (their private stars), keyed by target. */
export async function getViewerRatings(db: D1Like, userId: string): Promise<ViewerRatings> {
	const [{ results: locs }, { results: items }] = await Promise.all([
		db
			.prepare(`SELECT location_id, rating FROM location_reviews WHERE user_id = ?`)
			.bind(userId)
			.all<{ location_id: string; rating: number }>(),
		db
			.prepare(`SELECT item_id, rating FROM item_reviews WHERE user_id = ?`)
			.bind(userId)
			.all<{ item_id: string; rating: number }>()
	]);
	const locations: Record<string, number> = {};
	for (const r of locs) locations[r.location_id] = r.rating;
	const itemsMap: Record<string, number> = {};
	for (const r of items) itemsMap[r.item_id] = r.rating;
	return { locations, items: itemsMap };
}

/**
 * Upserts a user's review of a target: the rating (1..5) is always set. `body` is
 * three-valued: a string sets the text, `null` clears it, and `undefined` LEAVES an
 * existing review's text untouched (a bare star tap must never wipe a review; on a
 * brand-new row `undefined` inserts null). One row per (user, target) via the UNIQUE
 * key — a re-rating updates the same row, keeping its id/created_at and NOT touching
 * hidden_at (an edit can't un-hide a moderated review). `id` is used only on insert.
 */
export async function setReview(
	db: D1Like,
	target: ReviewTarget,
	id: string,
	userId: string,
	targetId: string,
	rating: number,
	body: string | null | undefined,
	now: number
): Promise<void> {
	const t = REVIEW_TABLES[target];
	// Only overwrite the body on conflict when the caller actually passed one; a
	// rating-only upsert (body === undefined) preserves the existing text.
	const bodyUpdate = body === undefined ? '' : ', body = excluded.body';
	await db
		.prepare(
			`INSERT INTO ${t.reviews} (id, user_id, ${t.col}, rating, body, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, ${t.col}) DO UPDATE SET
			   rating = excluded.rating, updated_at = excluded.updated_at${bodyUpdate}`
		)
		.bind(id, userId, targetId, rating, body ?? null, now, now)
		.run();
}

/** Deletes a user's review of a target (un-starring clears rating + any text). */
export async function clearReview(
	db: D1Like,
	target: ReviewTarget,
	userId: string,
	targetId: string
): Promise<void> {
	const t = REVIEW_TABLES[target];
	await db
		.prepare(`DELETE FROM ${t.reviews} WHERE user_id = ? AND ${t.col} = ?`)
		.bind(userId, targetId)
		.run();
}

/** Decodes a `${created_at}:${id}` keyset cursor, or null if malformed/absent. */
function parseReviewCursor(cursor: string | null | undefined): { at: number; id: string } | null {
	if (!cursor) return null;
	const sep = cursor.indexOf(':');
	if (sep <= 0) return null;
	const at = Number(cursor.slice(0, sep));
	const id = cursor.slice(sep + 1);
	if (!Number.isFinite(at) || id === '') return null;
	return { at, id };
}

/**
 * The reviews payload for one open target: the aggregate (count + average over all
 * non-hidden reviews, bare ratings included), a keyset page of PUBLIC reviews (text,
 * not hidden, newest first, excluding the viewer's own), and the viewer's own review
 * surfaced separately so the editor pre-fills. `limit` bounds the public page.
 */
export async function getReviews(
	db: D1Like,
	target: ReviewTarget,
	targetId: string,
	viewerId: string | null,
	limit: number,
	cursor?: string | null
): Promise<VenueReviews> {
	const t = REVIEW_TABLES[target];

	// A soft-deleted (permanently-closed) venue is dark on every other read
	// (migration 0015); don't leak its reviews here either. An unknown or closed
	// location reads as an empty payload, matching getLocationMapData. Items carry no
	// closed flag, so this guard applies to the location target only.
	if (target === 'location') {
		const loc = await db
			.prepare(`SELECT closed_at FROM locations WHERE id = ?`)
			.bind(targetId)
			.first<{ closed_at: number | null }>();
		if (!loc || loc.closed_at !== null) {
			return { summary: { count: 0, average: 0 }, reviews: [], own: null, nextCursor: null };
		}
	}

	const cur = parseReviewCursor(cursor);

	const summaryP = db
		.prepare(
			`SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS average
			 FROM ${t.reviews} WHERE ${t.col} = ? AND hidden_at IS NULL`
		)
		.bind(targetId)
		.first<{ count: number; average: number }>();

	// Fetch limit+1 to know whether a further page exists. Row-value keyset
	// (created_at, id) DESC gives a stable total order for pagination.
	const params: (string | number)[] = [targetId];
	let ownFilter = '';
	if (viewerId) {
		ownFilter = ` AND r.user_id <> ?`;
		params.push(viewerId);
	}
	let keyset = '';
	if (cur) {
		keyset = ` AND (r.created_at, r.id) < (?, ?)`;
		params.push(cur.at, cur.id);
	}
	params.push(limit + 1);
	const publicP = db
		.prepare(
			`SELECT r.id, r.rating, r.body, r.created_at, u.name AS author_name, u.picture AS author_picture
			 FROM ${t.reviews} r JOIN users u ON u.id = r.user_id
			 WHERE r.${t.col} = ? AND r.hidden_at IS NULL AND r.body IS NOT NULL AND trim(r.body) <> ''${ownFilter}${keyset}
			 ORDER BY r.created_at DESC, r.id DESC
			 LIMIT ?`
		)
		.bind(...params)
		.all<PublicReview>();

	const ownP = viewerId
		? db
				.prepare(
					`SELECT id, rating, body, created_at, updated_at, hidden_at
					 FROM ${t.reviews} WHERE user_id = ? AND ${t.col} = ?`
				)
				.bind(viewerId, targetId)
				.first<OwnReview>()
		: Promise.resolve(null);

	const [summary, publicRes, own] = await Promise.all([summaryP, publicP, ownP]);
	const rows = publicRes.results;
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	return {
		summary: {
			count: summary?.count ?? 0,
			average: summary?.average ?? 0
		},
		reviews: page,
		own: own ?? null,
		nextCursor: hasMore && last ? `${last.created_at}:${last.id}` : null
	};
}

// ── Moderation (reports / hide) ──────────────────────────────────────────────

/**
 * Records a report against a review and auto-hides it once
 * {@link REVIEW_AUTO_HIDE_THRESHOLD} distinct users have reported it. Idempotent per
 * reporter (UNIQUE(review_id, reporter)). Returns whether the review is now hidden.
 * A bad `reviewId` FK-violates on insert — the caller maps that to a 400.
 */
export async function reportReview(
	db: D1Like,
	target: ReviewTarget,
	reportId: string,
	reviewId: string,
	reporterId: string,
	reason: string | null,
	now: number,
	threshold: number = REVIEW_AUTO_HIDE_THRESHOLD
): Promise<{ hidden: boolean }> {
	const t = REVIEW_TABLES[target];
	await db
		.prepare(
			`INSERT OR IGNORE INTO ${t.reports} (id, review_id, reporter_user_id, reason, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.bind(reportId, reviewId, reporterId, reason, now)
		.run();
	const countRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${t.reports} WHERE review_id = ?`)
		.bind(reviewId)
		.first<{ n: number }>();
	if ((countRow?.n ?? 0) >= threshold) {
		// `admin_cleared = 0` makes a moderator's un-hide durable: a review a human has
		// vindicated is never re-hidden by a fresh wave of reports. `.changes` (>0 only
		// when a row was actually flipped) is what we report as newly-hidden.
		const res = await db
			.prepare(
				`UPDATE ${t.reviews} SET hidden_at = ?, hidden_reason = 'auto:reports'
				 WHERE id = ? AND hidden_at IS NULL AND admin_cleared = 0`
			)
			.bind(now, reviewId)
			.run();
		return { hidden: (res.meta?.changes ?? 0) > 0 };
	}
	return { hidden: false };
}

/**
 * Admin: hides (sets `hidden_at`/`hidden_reason`) or un-hides (nulls both) a review.
 * An un-hide (hiddenAt === null) also latches `admin_cleared = 1` so the report
 * auto-hide can never silently re-hide a review a moderator has vindicated; a hide
 * leaves the flag as-is (MAX keeps any prior clear, harmless while hidden_at is set).
 */
export async function setReviewHidden(
	db: D1Like,
	target: ReviewTarget,
	reviewId: string,
	hiddenAt: number | null,
	reason: string | null
): Promise<void> {
	const t = REVIEW_TABLES[target];
	const clearFlag = hiddenAt === null ? 1 : 0;
	await db
		.prepare(
			`UPDATE ${t.reviews} SET hidden_at = ?, hidden_reason = ?, admin_cleared = MAX(admin_cleared, ?) WHERE id = ?`
		)
		.bind(hiddenAt, reason, clearFlag, reviewId)
		.run();
}

/** Admin: reviews that are hidden or have at least one report, most-reported first. */
export async function getModerationReviews(
	db: D1Like,
	target: ReviewTarget,
	limit: number
): Promise<ModerationReview[]> {
	const t = REVIEW_TABLES[target];
	const { results } = await db
		.prepare(
			`SELECT r.id, tg.${t.nameCol} AS target_name, r.rating, r.body, r.created_at,
			        r.hidden_at, r.hidden_reason, u.name AS author_name,
			        (SELECT COUNT(*) FROM ${t.reports} rp WHERE rp.review_id = r.id) AS report_count
			 FROM ${t.reviews} r
			 JOIN users u ON u.id = r.user_id
			 JOIN ${t.targets} tg ON tg.id = r.${t.col}
			 WHERE r.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM ${t.reports} rp WHERE rp.review_id = r.id)
			 ORDER BY report_count DESC, r.created_at DESC
			 LIMIT ?`
		)
		.bind(limit)
		.all<ModerationReview>();
	return results;
}

// ---------------------------------------------------------------------------
// Dietary profile (migration 0013, reshaped by 0014)
// ---------------------------------------------------------------------------

/**
 * A signed-in user's saved diet: a single curated dietary tag id to pre-apply as
 * the map's filter, or `null` when none is set (or no row exists). The caller
 * sanitizes the value to a known dietary tag id before it is used as a filter
 * (see `sanitizeDiet` in $lib/diet-profile), so an id no longer in the catalog is
 * simply treated as "no filter".
 */
export async function getUserDiet(db: D1Like, userId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT diet FROM user_dietary_profile WHERE user_id = ?`)
		.bind(userId)
		.first<{ diet: string | null }>();
	return row?.diet ?? null;
}

/**
 * Saves (upserts) a user's selected diet — a single curated dietary tag id, or
 * `null` to clear it. The caller is responsible for sanitizing the id to a known
 * dietary tag (see `sanitizeDiet`). One row per user, keyed by user_id.
 */
export async function setUserDiet(
	db: D1Like,
	userId: string,
	diet: string | null,
	now: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_dietary_profile (user_id, diet, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				diet = excluded.diet,
				updated_at = excluded.updated_at`
		)
		.bind(userId, diet, now)
		.run();
}

// ---------------------------------------------------------------------------
// Saved UI locale (migration 0024) — i18n phase 4
// ---------------------------------------------------------------------------

/**
 * Saves (upserts) a user's UI locale so it follows them across devices. One row
 * per user, keyed by user_id, in its OWN table — fully independent of the dietary
 * profile, so neither setter clobbers the other. The caller validates `locale` to
 * a supported tag before calling (see the setLocale command).
 */
export async function setUserLocale(
	db: D1Like,
	userId: string,
	locale: Locale,
	now: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_locale (user_id, locale, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				locale = excluded.locale,
				updated_at = excluded.updated_at`
		)
		.bind(userId, locale, now)
		.run();
}
