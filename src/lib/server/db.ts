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
//     'course' | 'ingredient'. Items link to tags through `item_tags`, whose
//     `optional` flag marks a tag/ingredient that can be added or left out.
// ---------------------------------------------------------------------------

// Type-only import (erased at build time, so it adds no runtime dependency and
// keeps this module runtime-agnostic). `category.ts` is the canonical, client-safe
// home of the category union; re-exported below as part of this module's contract.
import type { Category } from '../category';
// Value import (tiny, pure, client-safe): the canonical display-address formatter,
// so the single-line `address` is composed identically wherever a location is read.
import { formatAddress } from '../address';
// Value import (tiny, pure, client-safe): the deterministic half of ingredient
// canonicalization — accent-folding + whitespace/case normalization — so the write
// path folds an ingredient name to the same identity the alias seed script uses.
import { foldIngredientName } from '../tags';

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

export type { Category };

// Canonical, app-defined tag identifiers (dietary + course). These are part of
// the app contract and fixed — they are NOT user-authored, so this union is the
// single source of truth. Ingredient tags are DATA (ids like `ing:tomato`),
// created from item ingredients, and are deliberately not part of this union.
export type TagId =
	| 'vegan'
	| 'vegetarian'
	| 'gluten_free'
	| 'dairy_free'
	| 'nut_free'
	| 'halal'
	| 'dessert'
	| 'drink';

/**
 * What a tag describes. `dietary` tags (vegan, halal, …) are source-asserted —
 * only applied when a source explicitly designates the item. `course` tags
 * (dessert, drink) describe what kind of item it is and are applied factually.
 * `ingredient` tags name an ingredient of the item; they are data, not part of
 * the curated {@link TagId} set.
 */
export type TagType = 'dietary' | 'course' | 'ingredient';

export interface Tag {
	id: string;
	name: string;
	tag_type: TagType;
}

/** A tag as applied to a specific item, carrying the per-edge `optional` flag. */
export interface ItemTag extends Tag {
	/** True if this tag/ingredient is optional for the item (can be added/omitted). */
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
	/** Chain this location belongs to, or `null` for an independent venue. */
	brand_id: string | null;
	/**
	 * The menu this location serves: a shared brand menu (chain branch), or its
	 * own private menu (independent venue). `null` only when it has no menu/items.
	 */
	menu_id: string | null;
	/** Citations for where this location's data came from (may be empty). */
	sources: Source[];
}

/**
 * A menu item. Belongs to a {@link Menu} — private to one venue, or shared
 * across a chain's branches. Ingredients are represented as `ingredient`-typed
 * entries in {@link tags}, not as a free-text field.
 */
export interface Item {
	id: string;
	menu_id: string;
	item_name: string;
	/** Short free-text description of the item (may be null). */
	description: string | null;
	price: number | null;
	/**
	 * Upper-case ISO-4217 code the {@link price} is denominated in, taken from the
	 * item's menu on read (see {@link Menu.currency}) so a price is always
	 * self-describing. Defaults to "CAD".
	 */
	currency: string;
	/** Tags applied to this item (dietary, course, and ingredient), with `optional`. */
	tags: ItemTag[];
	/** Citations for where this item's data came from (may be empty). */
	sources: Source[];
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
}

/**
 * Everything the map page needs in one payload. Each menu (private or shared) is
 * sent ONCE, keyed by `menu_id`, with its items resolved (tags + merged sources);
 * a 500-branch chain ships its menu a single time instead of 500. The client
 * joins each {@link MapLocation} to its `menus` entry, applying the location's
 * `overrides`, to reconstruct the effective menu (see `resolveLocation` in +page.svelte).
 */
export interface MapData {
	locations: MapLocation[];
	/** Menus referenced by the returned locations, items resolved once, keyed by menu_id. */
	menus: Record<string, Item[]>;
}

/**
 * A geographic bounding box (a map viewport), used to scope a {@link MapData}
 * read to just the visible area. Longitudes are treated as a simple `min..max`
 * range, so a box spanning the antimeridian is not supported (the same planar
 * assumption the rest of the app makes).
 */
export interface Bounds {
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
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

// The canonical tag list (dietary first, then course) — the display/filter order
// on the frontend. These are app-defined, never created from the UI, and seeded
// into D1 by migrations/0001_init.sql (renamed to (name, tag_type) by 0004).
// Ingredient tags are NOT listed here; they are data created from item ingredients.
export const TAGS: readonly Tag[] = [
	{ id: 'vegan', name: 'Vegan', tag_type: 'dietary' },
	{ id: 'vegetarian', name: 'Vegetarian', tag_type: 'dietary' },
	{ id: 'gluten_free', name: 'Gluten-free', tag_type: 'dietary' },
	{ id: 'dairy_free', name: 'Dairy-free', tag_type: 'dietary' },
	{ id: 'nut_free', name: 'Nut-free', tag_type: 'dietary' },
	{ id: 'halal', name: 'Halal', tag_type: 'dietary' },
	{ id: 'dessert', name: 'Dessert', tag_type: 'course' },
	{ id: 'drink', name: 'Drink', tag_type: 'course' }
];

/**
 * Internal raw shape of an `items` row before its tags, sources and (menu-derived)
 * currency are attached. `currency` is NOT a column on `items`; it is read from the
 * item's menu and attached when the {@link Item} is assembled.
 */
type ItemRow = Omit<Item, 'tags' | 'sources' | 'currency'>;

/** Raw `location_item_overrides` row (`available` stored as 0/1/NULL). */
interface OverrideRow {
	location_id: string;
	item_id: string;
	available: number | null;
	price: number | null;
}

/** Internal raw shape of a `locations` row before its sources are attached. */
// The raw DB row: the structured columns, but not `sources` (joined) or the
// derived `address` (composed on read).
type LocationRow = Omit<Location, 'sources' | 'address'>;

/** Raw `*_sources` row keyed by its owner id (item_id or location_id). */
interface SourceRow {
	owner_id: string;
	url: string;
	label: string | null;
}

/** An (item, tag) join row, with the per-edge `optional` flag (0/1). */
interface ItemTagRow {
	owner_id: string;
	id: string;
	name: string;
	tag_type: TagType;
	optional: number;
}

/** A (location, tag) join row used for the location-level tag overview (no `optional`). */
interface LocationTagRow {
	owner_id: string;
	id: string;
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
function groupItemTags(rows: ItemTagRow[]): Map<string, ItemTag[]> {
	const byOwner = new Map<string, ItemTag[]>();
	for (const row of rows) {
		const list = byOwner.get(row.owner_id) ?? [];
		list.push({ id: row.id, name: row.name, tag_type: row.tag_type, optional: row.optional !== 0 });
		byOwner.set(row.owner_id, list);
	}
	return byOwner;
}

/** Groups (location, tag) join rows into a distinct {@link Tag} list per location. */
function groupLocationTagsDistinct(rows: LocationTagRow[]): Map<string, Tag[]> {
	const byOwner = new Map<string, Tag[]>();
	const seen = new Map<string, Set<string>>();
	for (const row of rows) {
		let list = byOwner.get(row.owner_id);
		let ids = seen.get(row.owner_id);
		if (!list || !ids) {
			list = [];
			ids = new Set();
			byOwner.set(row.owner_id, list);
			seen.set(row.owner_id, ids);
		}
		if (ids.has(row.id)) continue;
		ids.add(row.id);
		list.push({ id: row.id, name: row.name, tag_type: row.tag_type });
	}
	return byOwner;
}

/** Concatenates two source lists, dropping later duplicates by URL (first wins). */
function mergeSources(primary: Source[], secondary: Source[]): Source[] {
	if (secondary.length === 0) return primary;
	const seen = new Set(primary.map((s) => s.url));
	const merged = [...primary];
	for (const s of secondary) {
		if (seen.has(s.url)) continue;
		seen.add(s.url);
		merged.push(s);
	}
	return merged;
}

/**
 * Splits a free-text ingredient string into normalized, de-duplicated ingredient
 * names. Each part is canonicalized by {@link foldIngredientName} (trim, lower-case,
 * accent-fold, collapse whitespace) — so "Jalapeño" and "jalapeno" yield the same
 * name — then mapped to a tag id of `ing:<name>`. Plurals and synonyms are NOT
 * folded here (they aren't rule-derivable); they are redirected to a canonical tag
 * at link time via the `ingredient_aliases` map (see {@link ingredientLinkStmts}).
 * Migration 0004 derived the original tags with a bare trim+lower-case; the accent
 * fold is an additive refinement applied to every write from here on.
 */
function parseIngredients(raw: string | null | undefined): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(',')) {
		const name = foldIngredientName(part);
		if (name === '' || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/** Tag id for an ingredient name (matches migration 0004). */
function ingredientTagId(name: string): string {
	return `ing:${name}`;
}

// ---------------------------------------------------------------------------
// SQL (D1 enforces foreign keys; schema lives in migrations/)
// ---------------------------------------------------------------------------

const LOCATION_FIELDS = `id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, brand_id, menu_id`;
const ITEM_FIELDS = `id, menu_id, item_name, description, price`;
/** Item-tag join projection (aliased to {@link ItemTagRow}). */
const ITEM_TAG_SELECT = `t.id AS id, t.name AS name, t.tag_type AS tag_type, it.optional AS optional`;

/**
 * Hard cap on how many locations a single {@link getMapData} viewport read
 * returns. The map page no longer gates fetching on a minimum zoom, so a fully
 * zoomed-out box can cover the whole dataset; this bounds the payload — and the
 * markers drawn — to a sane size. The alphabetically-first matches win (see the
 * deterministic ORDER BY in {@link queryMapData}). Mirrored on the client only to
 * label a capped result set; this module stays the source of truth for the value.
 */
export const MAP_RESULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getAllTags(): Tag[] {
	return TAGS.map((tag) => ({ ...tag }));
}

/**
 * Hard cap on how many tag matches {@link searchTagVocabulary} returns for one
 * query. The tag filter's picker only needs the top matches, and the ingredient
 * vocabulary runs to thousands of rows. Mirrored on the client only to label a
 * capped result set; this module stays the source of truth for the value.
 */
export const TAG_SEARCH_LIMIT = 50;

/**
 * Searches the whole tag vocabulary — the curated dietary/course tags AND the
 * `ingredient` tags created from item data — by name substring, for the tag
 * filter's searchable picker. An empty query returns just the curated tags (the
 * common default the picker shows before the user types). Otherwise matches are
 * ranked exact → prefix → substring, then curated (dietary, course) before
 * ingredient, then SHORTEST name first so clean ingredient names ("aioli") sort
 * above the long free-text phrases some menus produced ("a side of maple syrup
 * and fresh fruit slices…"), then alphabetical. Capped at {@link TAG_SEARCH_LIMIT}.
 *
 * The substring match runs against `tags_fts`, an FTS5 trigram index over tag
 * names (see migrations/0006), so a `LIKE '%q%'` scan over thousands of
 * ingredient rows becomes an index lookup. Two constraints follow from the
 * trigram LIKE optimisation and are load-bearing:
 *   • No `ESCAPE` clause — it disables the trigram index (forces a full scan).
 *     Any `%`/`_` the user typed is simply dropped (both are vanishingly rare in
 *     tag names); if nothing is left, the query is treated as empty.
 *   • Patterns shorter than 3 characters fall back to a scan of the (small) FTS
 *     table — still correct, just unindexed.
 */
export async function searchTagVocabulary(
	db: D1Like,
	rawQuery: string,
	limit = TAG_SEARCH_LIMIT
): Promise<Tag[]> {
	// Fold the query the same way ingredient names are folded on write, so an
	// accented query ("jalapeño") matches the accent-folded canonical tag
	// ("jalapeno") directly — diacritics need no alias rows on either side. Then
	// strip LIKE wildcards (rare in tag names) so a typed %/_ can't act as one.
	const q = foldIngredientName(rawQuery);
	if (q === '') return getAllTags();
	const safe = q.replace(/[%_]/g, '');
	if (safe === '') return getAllTags();
	// Two match sources, UNIONed (which de-duplicates a tag matched both ways):
	//   1. tag NAMES via the `tags_fts` trigram index (must stay ESCAPE-free, see
	//      migration 0006), so a typed canonical name matches.
	//   2. ALIAS spellings via `ingredient_aliases`, mapped back to their CANONICAL
	//      tag — so typing a variant ("tomatoes", "garbanzo", "jalapeño") still
	//      surfaces the canonical tag (and, post-merge, all of its items). The
	//      alias table is small and curated, so a plain LIKE scan over it is cheap
	//      (no FTS needed); `safe` already stripped %/_ so no ESCAPE is required.
	// `LIMIT` is a trusted integer constant, so it is interpolated rather than bound
	// (matching MAP_RESULT_LIMIT above); every user value is bound. The ranking's
	// LOWER()/LENGTH() expressions run only over the matched rows.
	const { results } = await db
		.prepare(
			`SELECT id, name, tag_type FROM (
				SELECT t.id AS id, t.name AS name, t.tag_type AS tag_type
				FROM tags_fts f JOIN tags t ON t.rowid = f.rowid
				WHERE f.name LIKE ?
				UNION
				SELECT t.id AS id, t.name AS name, t.tag_type AS tag_type
				FROM ingredient_aliases a JOIN tags t ON t.id = a.canonical_id
				WHERE a.alias LIKE ?
			 )
			 ORDER BY
				CASE
					WHEN LOWER(name) = ? THEN 0
					WHEN LOWER(name) LIKE ? THEN 1
					ELSE 2
				END,
				CASE tag_type WHEN 'dietary' THEN 0 WHEN 'course' THEN 1 ELSE 2 END,
				LENGTH(name),
				name
			 LIMIT ${limit}`
		)
		.bind(`%${safe}%`, `%${safe}%`, safe, `${safe}%`)
		.all<Tag>();
	return results;
}

/**
 * Optional server-side filters for {@link getLocationsWithTags}, pushed into SQL
 * so a bounded list no longer reads (and ships) the whole table. `bbox` and
 * `category` narrow the rows — and the joined tag/source scans with them; `limit`/
 * `offset` page the name-ordered result. A radius query is served by passing the
 * covering `bbox` and refining to the exact circle in the caller, so this layer
 * stays geo-free. With no filter the behaviour is unchanged (every location).
 */
export interface LocationListFilter {
	bbox?: Bounds;
	category?: Category;
	/** Case-insensitive substring match on the location name (LIKE %query%). */
	nameLike?: string;
	limit?: number;
	offset?: number;
}

/** Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`). */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function getLocationsWithTags(
	db: D1Like,
	filter: LocationListFilter = {}
): Promise<LocationWithTags[]> {
	// bbox/category predicates (bound), shared verbatim by all three reads so the
	// joined tag/source scans cover exactly the same rows. Aliased to `l` so the
	// identical condition strings drop into every query.
	const conds: string[] = [];
	const params: (string | number)[] = [];
	if (filter.bbox) {
		conds.push('l.latitude BETWEEN ? AND ?', 'l.longitude BETWEEN ? AND ?');
		params.push(filter.bbox.minLat, filter.bbox.maxLat, filter.bbox.minLng, filter.bbox.maxLng);
	}
	if (filter.category) {
		conds.push('l.category = ?');
		params.push(filter.category);
	}
	if (filter.nameLike && filter.nameLike.trim() !== '') {
		conds.push("l.name LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLikePattern(filter.nameLike.trim())}%`);
	}
	const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
	const tagExtra = conds.length ? ` AND ${conds.join(' AND ')}` : '';
	// LIMIT/OFFSET are trusted integers → interpolated (matching MAP_RESULT_LIMIT),
	// so the one bound `params` set stays identical across all three statements.
	let pagingSql = '';
	if (filter.limit !== undefined) pagingSql = ` LIMIT ${Math.max(0, Math.trunc(filter.limit))}`;
	else if (filter.offset) pagingSql = ' LIMIT -1';
	if (filter.offset) pagingSql += ` OFFSET ${Math.max(0, Math.trunc(filter.offset))}`;

	const [{ results: locations }, { results: tagRows }, { results: sourceRows }] = await Promise.all(
		[
			db
				.prepare(
					`SELECT ${LOCATION_FIELDS} FROM locations l ${whereSql} ORDER BY l.name${pagingSql}`
				)
				.bind(...params)
				.all<LocationRow>(),
			// Distinct dietary/course tags offered across a location's menu, excluding
			// items it has overridden to unavailable. Ingredient tags are omitted — the
			// location overview is about dietary options, not every ingredient.
			db
				.prepare(
					`SELECT DISTINCT l.id AS owner_id, t.id AS id, t.name AS name, t.tag_type AS tag_type
				 FROM locations l
				 JOIN items i ON i.menu_id = l.menu_id
				 JOIN item_tags it ON it.item_id = i.id
				 JOIN tags t ON t.id = it.tag_id
				 LEFT JOIN location_item_overrides o
					ON o.location_id = l.id AND o.item_id = i.id
				 WHERE l.menu_id IS NOT NULL
					AND t.tag_type IN ('dietary', 'course')
					AND (o.available IS NULL OR o.available <> 0)${tagExtra}
				 ORDER BY l.id, t.rowid`
				)
				.bind(...params)
				.all<LocationTagRow>(),
			db
				.prepare(
					`SELECT location_id AS owner_id, url, label FROM location_sources` +
						(conds.length
							? ` WHERE location_id IN (SELECT l.id FROM locations l ${whereSql})`
							: '') +
						` ORDER BY rowid`
				)
				.bind(...(conds.length ? params : []))
				.all<SourceRow>()
		]
	);

	const tagsByLocation = groupLocationTagsDistinct(tagRows);
	const sourcesByLocation = groupSources(sourceRows);

	return locations.map((loc) => ({
		...loc,
		address: formatAddress(loc),
		tags: tagsByLocation.get(loc.id) ?? [],
		sources: sourcesByLocation.get(loc.id) ?? []
	}));
}

/**
 * The subset of `ids` that already exist as rows in `table`. Lets the MCP create
 * tools make explicit-id inserts idempotent: a caller that retries a batch with
 * the same ids (e.g. after a dropped response) can skip the rows already written
 * instead of failing the whole batch on a primary-key collision.
 */
const EXISTING_IDS_TABLES = new Set(['locations', 'items', 'brands', 'menus']);

export async function existingIds(
	db: D1Like,
	table: 'locations' | 'items' | 'brands' | 'menus',
	ids: string[]
): Promise<Set<string>> {
	// `table` is interpolated into the SQL, so guard it against an allowlist at
	// runtime (the TS union is erased and can't stop a future dynamic caller).
	if (!EXISTING_IDS_TABLES.has(table)) throw new Error(`existingIds: invalid table "${table}".`);
	if (ids.length === 0) return new Set();
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<{ id: string }>();
	return new Set(results.map((r) => r.id));
}

/** Canonical key for a coordinate pair, used to match a resolved point to an existing row. */
export function coordinateKey(latitude: number, longitude: number): string {
	return `${latitude},${longitude}`;
}

/**
 * Maps each given coordinate that ALREADY has a location to that location
 * ({@link coordinateKey} → id/name). Because OSM-imported coordinates are stored
 * verbatim, a true duplicate sits at coordinate-identical lat/lon — so this lets
 * create_locations skip re-importing a venue already on the map. Coordinates with
 * no existing location are absent from the map.
 */
export async function existingLocationsAtCoords(
	db: D1Like,
	coords: { latitude: number; longitude: number }[]
): Promise<Map<string, { id: string; name: string }>> {
	const distinct = [
		...new Map(coords.map((c) => [coordinateKey(c.latitude, c.longitude), c])).values()
	];
	if (distinct.length === 0) return new Map();
	const conds = distinct.map(() => '(latitude = ? AND longitude = ?)').join(' OR ');
	const binds = distinct.flatMap((c) => [c.latitude, c.longitude]);
	const { results } = await db
		.prepare(`SELECT id, name, latitude, longitude FROM locations WHERE ${conds}`)
		.bind(...binds)
		.all<{ id: string; name: string; latitude: number; longitude: number }>();
	const out = new Map<string, { id: string; name: string }>();
	for (const r of results) {
		const key = coordinateKey(r.latitude, r.longitude);
		if (!out.has(key)) out.set(key, { id: r.id, name: r.name });
	}
	return out;
}

/**
 * Returns everything the map page needs for the given viewport in one payload
 * (see {@link MapData}): every location inside `bounds` with its per-item
 * overrides, plus each menu those locations reference resolved ONCE (keyed by
 * menu_id, each item carrying its tags and merged sources). The client joins the
 * two — applying each location's overrides — to reconstruct the effective menu,
 * so a shared chain menu travels the wire a single time instead of once per branch.
 *
 * Scoping the read to the visible box keeps the payload bounded as the dataset
 * grows to whole countries, and at most {@link MAP_RESULT_LIMIT} locations (the
 * alphabetically-first) are returned for any one box. Built in bulk to avoid an
 * N+1 query per location.
 */
export function getMapData(db: D1Like, bounds: Bounds): Promise<MapData> {
	return queryMapData(db, `latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`, [
		bounds.minLat,
		bounds.maxLat,
		bounds.minLng,
		bounds.maxLng
	]);
}

/**
 * Like {@link getMapData} but for a single location by id, returned in the same
 * {@link MapData} shape. Used by the map's detail view to resolve a location that
 * isn't in the current viewport. Yields an empty payload if no location has that id.
 */
export function getLocationMapData(db: D1Like, id: string): Promise<MapData> {
	return queryMapData(db, `id = ?`, [id]);
}

/**
 * Shared implementation of {@link getMapData} / {@link getLocationMapData}.
 * `locFilter` is a predicate over the `locations` table (its `?` placeholders
 * bound from `params`); every sub-row read is scoped to the locations it selects
 * — and the menus those locations reference — so neither a viewport box nor a
 * single-id lookup ever pulls an unscoped table.
 */
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[]
): Promise<MapData> {
	// Sub-selects that resolve, from `locFilter`, the in-scope location ids, the
	// menus they reference, and the items on those menus.
	//
	// The location set is capped at MAP_RESULT_LIMIT via a deterministic
	// `ORDER BY name, id LIMIT` applied IDENTICALLY here in `inLocations` and in
	// the main row read below, so both select the exact same rows — every scoped
	// sub-read therefore covers precisely the returned set. The LIMIT is a trusted
	// integer literal, so it is interpolated rather than bound; this keeps each
	// statement's single `locFilter` placeholder count correct under `.bind(...params)`.
	const capClause = `ORDER BY name, id LIMIT ${MAP_RESULT_LIMIT}`;
	const inLocations = `SELECT id FROM locations WHERE ${locFilter} ${capClause}`;
	const inMenus = `SELECT DISTINCT menu_id FROM locations WHERE menu_id IS NOT NULL AND id IN (${inLocations})`;
	const inItems = `SELECT id FROM items WHERE menu_id IN (${inMenus})`;

	const [
		{ results: locations },
		{ results: itemRows },
		{ results: menuCurrencyRows },
		{ results: itemTagRows },
		{ results: itemSourceRows },
		{ results: menuSourceRows },
		{ results: locationSourceRows },
		{ results: overrideRows }
	] = await Promise.all([
		db
			.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE ${locFilter} ${capClause}`)
			.bind(...params)
			.all<LocationRow>(),
		db
			.prepare(
				`SELECT ${ITEM_FIELDS} FROM items WHERE menu_id IN (${inMenus}) ORDER BY menu_id, item_name`
			)
			.bind(...params)
			.all<ItemRow>(),
		db
			.prepare(`SELECT id, currency FROM menus WHERE id IN (${inMenus})`)
			.bind(...params)
			.all<{ id: string; currency: string }>(),
		db
			.prepare(
				`SELECT it.item_id AS owner_id, ${ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 WHERE it.item_id IN (${inItems})
				 ORDER BY t.rowid`
			)
			.bind(...params)
			.all<ItemTagRow>(),
		db
			.prepare(
				`SELECT item_id AS owner_id, url, label FROM item_sources
				 WHERE item_id IN (${inItems}) ORDER BY rowid`
			)
			.bind(...params)
			.all<SourceRow>(),
		db
			.prepare(
				`SELECT menu_id AS owner_id, url, label FROM menu_sources
				 WHERE menu_id IN (${inMenus}) ORDER BY rowid`
			)
			.bind(...params)
			.all<SourceRow>(),
		db
			.prepare(
				`SELECT location_id AS owner_id, url, label FROM location_sources
				 WHERE location_id IN (${inLocations}) ORDER BY rowid`
			)
			.bind(...params)
			.all<SourceRow>(),
		db
			.prepare(
				`SELECT location_id, item_id, available, price FROM location_item_overrides
				 WHERE location_id IN (${inLocations}) ORDER BY rowid`
			)
			.bind(...params)
			.all<OverrideRow>()
	]);

	// Resolve each menu item once (tags + item sources, with the menu-level source
	// appended) and group by menu. The client applies the per-location price/
	// availability deltas as it expands a menu onto each branch.
	const tagsByItem = groupItemTags(itemTagRows);
	const sourcesByItem = groupSources(itemSourceRows);
	const sourcesByMenu = groupSources(menuSourceRows);
	const sourcesByLocation = groupSources(locationSourceRows);
	const currencyByMenu = new Map(menuCurrencyRows.map((r) => [r.id, r.currency]));

	const menus: Record<string, Item[]> = {};
	for (const row of itemRows) {
		(menus[row.menu_id] ??= []).push({
			id: row.id,
			menu_id: row.menu_id,
			item_name: row.item_name,
			description: row.description,
			price: row.price,
			currency: currencyByMenu.get(row.menu_id) ?? DEFAULT_CURRENCY,
			tags: tagsByItem.get(row.id) ?? [],
			sources: mergeSources(sourcesByItem.get(row.id) ?? [], sourcesByMenu.get(row.menu_id) ?? [])
		});
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

	const mapLocations: MapLocation[] = locations.map((loc) => ({
		...loc,
		address: formatAddress(loc),
		sources: sourcesByLocation.get(loc.id) ?? [],
		overrides: overridesByLocation.get(loc.id) ?? []
	}));

	return { locations: mapLocations, menus };
}

export async function getLocationById(db: D1Like, id: string): Promise<Location | null> {
	const [row, { results: sources }] = await Promise.all([
		db
			.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE id = ?`)
			.bind(id)
			.first<LocationRow>(),
		db
			.prepare(`SELECT url, label FROM location_sources WHERE location_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	return { ...row, address: formatAddress(row), sources };
}

/** Returns all items of a menu, each with its tags and sources (item + menu-level). */
async function getItemsByMenu(db: D1Like, menuId: string): Promise<Item[]> {
	const [
		{ results: rows },
		menuRow,
		{ results: tagRows },
		{ results: itemSourceRows },
		{ results: menuSourceRows }
	] = await Promise.all([
		db
			.prepare(`SELECT ${ITEM_FIELDS} FROM items WHERE menu_id = ? ORDER BY item_name`)
			.bind(menuId)
			.all<ItemRow>(),
		db
			.prepare(`SELECT currency FROM menus WHERE id = ?`)
			.bind(menuId)
			.first<{ currency: string }>(),
		db
			.prepare(
				`SELECT it.item_id AS owner_id, ${ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 JOIN items i ON i.id = it.item_id
				 WHERE i.menu_id = ?
				 ORDER BY t.rowid`
			)
			.bind(menuId)
			.all<ItemTagRow>(),
		db
			.prepare(
				`SELECT s.item_id AS owner_id, s.url AS url, s.label AS label
				 FROM item_sources s
				 JOIN items i ON i.id = s.item_id
				 WHERE i.menu_id = ?
				 ORDER BY s.rowid`
			)
			.bind(menuId)
			.all<SourceRow>(),
		db
			.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(menuId)
			.all<Source>()
	]);

	const tagsByItem = groupItemTags(tagRows);
	const sourcesByItem = groupSources(itemSourceRows);
	const currency = menuRow?.currency ?? DEFAULT_CURRENCY;
	return rows.map((row) => ({
		...row,
		currency,
		tags: tagsByItem.get(row.id) ?? [],
		sources: mergeSources(sourcesByItem.get(row.id) ?? [], menuSourceRows)
	}));
}

/**
 * Returns a location's OWN items — those on its private menu (brand_id NULL).
 * A chain branch serves a shared brand menu and owns no items of its own, so it
 * yields an empty list (read those items via {@link getMenuWithItems}).
 */
export async function getFoodByLocation(db: D1Like, locationId: string): Promise<Item[]> {
	const owner = await db
		.prepare(
			`SELECT l.menu_id AS menu_id, m.brand_id AS brand_id
			 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
			 WHERE l.id = ?`
		)
		.bind(locationId)
		.first<{ menu_id: string | null; brand_id: string | null }>();
	if (!owner || owner.menu_id === null || owner.brand_id !== null) return [];
	return getItemsByMenu(db, owner.menu_id);
}

/** Returns a single item with its tags and sources (item + menu-level), or `null`. */
export async function getItemById(db: D1Like, id: string): Promise<Item | null> {
	const [row, { results: tags }, { results: itemSources }] = await Promise.all([
		db.prepare(`SELECT ${ITEM_FIELDS} FROM items WHERE id = ?`).bind(id).first<ItemRow>(),
		db
			.prepare(
				`SELECT ${ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 WHERE it.item_id = ?
				 ORDER BY t.rowid`
			)
			.bind(id)
			.all<ItemTagRow>(),
		db
			.prepare(`SELECT url, label FROM item_sources WHERE item_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	const [{ results: menuSources }, menuRow] = await Promise.all([
		db
			.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(row.menu_id)
			.all<Source>(),
		db
			.prepare(`SELECT currency FROM menus WHERE id = ?`)
			.bind(row.menu_id)
			.first<{ currency: string }>()
	]);
	return {
		...row,
		currency: menuRow?.currency ?? DEFAULT_CURRENCY,
		tags: tags.map((t) => ({
			id: t.id,
			name: t.name,
			tag_type: t.tag_type,
			optional: t.optional !== 0
		})),
		sources: mergeSources(itemSources, menuSources)
	};
}

// ---------------------------------------------------------------------------
// Writes — shared item-write helpers
// ---------------------------------------------------------------------------

/** Tag/ingredient/source content for one item write (insert or update). */
interface ItemContent {
	tags?: TagId[];
	optionalTags?: TagId[];
	ingredients?: string | null;
	optionalIngredients?: string | null;
	sources?: Source[];
}

/** A single `item_tags` link statement. */
function linkTagStmt(db: D1Like, itemId: string, tagId: string, optional: 0 | 1): D1PreparedLike {
	return db
		.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional) VALUES (?, ?, ?)`)
		.bind(itemId, tagId, optional);
}

/**
 * Statements linking an item to ONE ingredient, resolving it through the
 * `ingredient_aliases` canonicalization map: a variant spelling (a known plural
 * like "tomatoes", or a synonym like "garbanzo") is redirected to its canonical
 * tag (`ing:tomato`, `ing:chickpea`) instead of minting a near-duplicate. Accents
 * are already folded by {@link parseIngredients}, so only the non-rule-derivable
 * variants need the table.
 *
 * Both the canonical-tag ensure and the link resolve the alias IN SQL (via a
 * COALESCE subquery), so these statements stay batchable with no extra round-trip.
 * When `name` is not a known variant, COALESCE falls back to `ing:<name>`. The
 * ensured tag's display name is `SUBSTR(id, 5)` — everything after the `ing:`
 * prefix — which equals the stored lower-cased ingredient name in both branches.
 */
function ingredientLinkStmts(
	db: D1Like,
	itemId: string,
	name: string,
	optional: 0 | 1
): D1PreparedLike[] {
	const tagId = ingredientTagId(name);
	return [
		db
			.prepare(
				`INSERT OR IGNORE INTO tags (id, name, tag_type)
				 SELECT cid, SUBSTR(cid, 5), 'ingredient'
				 FROM (SELECT COALESCE((SELECT canonical_id FROM ingredient_aliases WHERE alias = ?), ?) AS cid)`
			)
			.bind(name, tagId),
		db
			.prepare(
				`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional)
				 VALUES (?, COALESCE((SELECT canonical_id FROM ingredient_aliases WHERE alias = ?), ?), ?)`
			)
			.bind(itemId, name, tagId, optional)
	];
}

/**
 * Statements that link an item to its tags: curated dietary/course tags (from
 * `tags`/`optionalTags`) plus ingredient tags parsed from `ingredients`/
 * `optionalIngredients` (creating the canonical ingredient rows on the fly, see
 * {@link ingredientLinkStmts}).
 */
function tagLinkStmts(db: D1Like, itemId: string, content: ItemContent): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];
	for (const tagId of content.tags ?? []) stmts.push(linkTagStmt(db, itemId, tagId, 0));
	for (const tagId of content.optionalTags ?? []) stmts.push(linkTagStmt(db, itemId, tagId, 1));
	for (const name of parseIngredients(content.ingredients))
		stmts.push(...ingredientLinkStmts(db, itemId, name, 0));
	for (const name of parseIngredients(content.optionalIngredients))
		stmts.push(...ingredientLinkStmts(db, itemId, name, 1));
	return stmts;
}

/** Statements that link an item to its source URLs. */
function sourceLinkStmts(
	db: D1Like,
	itemId: string,
	sources: Source[] | undefined
): D1PreparedLike[] {
	return (sources ?? []).map((source) =>
		db
			.prepare(`INSERT OR IGNORE INTO item_sources (item_id, url, label) VALUES (?, ?, ?)`)
			.bind(itemId, source.url, source.label ?? null)
	);
}

/** Shape of one item to insert into a given menu. */
export interface ItemInsertSpec extends ItemContent {
	id?: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
}

/** Builds the full statement list to insert one item (row + tags + sources). */
function insertItemStmts(
	db: D1Like,
	id: string,
	menuId: string,
	spec: ItemInsertSpec
): D1PreparedLike[] {
	return [
		db
			.prepare(
				`INSERT INTO items (id, menu_id, item_name, description, price) VALUES (?, ?, ?, ?, ?)`
			)
			.bind(id, menuId, spec.item_name, spec.description ?? null, spec.price ?? null),
		...tagLinkStmts(db, id, spec),
		...sourceLinkStmts(db, id, spec.sources)
	];
}

// ---------------------------------------------------------------------------
// Writes — locations
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertLocations} (one per location). */
export type LocationInsert = Omit<
	Location,
	'id' | 'sources' | 'brand_id' | 'menu_id' | 'address'
> & {
	id?: string;
	brand_id?: string | null;
	menu_id?: string | null;
	sources?: Source[];
	/**
	 * Currency (ISO-4217, default CAD) for the private menu created when `items` are
	 * given. Ignored for a chain branch (which shares its menu's currency).
	 */
	currency?: string;
	/**
	 * The venue's OWN menu items, created on a private menu in the SAME atomic
	 * batch as the location (independent venues only). Equivalent to a follow-up
	 * {@link insertFoods} call folded in. Must NOT be combined with `brand_id`/
	 * `menu_id` — a chain branch shares its menu rather than owning items.
	 */
	items?: ItemInsertSpec[];
};

/**
 * Inserts many locations (with their sources, and optionally each venue's own
 * menu items) in one atomic batch and returns their ids in input order: either
 * every location is written or, on any error, none are. Pass a single location to
 * add just one. Ideal for backfilling a chain's branches — give each the same
 * `brand_id`/`menu_id` so they all serve the shared menu — or for adding an
 * independent venue and its menu at once via `items`.
 */
export async function insertLocations(db: D1Like, locs: LocationInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const loc of locs) {
		const id = loc.id ?? crypto.randomUUID();
		ids.push(id);
		const hasItems = loc.items !== undefined && loc.items.length > 0;
		if (hasItems && (loc.brand_id || loc.menu_id)) {
			throw new Error(
				`Location "${loc.name}" has inline \`items\` but is linked to a chain ` +
					`(brand_id/menu_id). Inline items are for an independent venue's own menu; a chain ` +
					`branch shares its menu — use create_items with a menu_id, or set_location_item_override for a delta.`
			);
		}
		// An independent venue with inline items gets a private menu created in the
		// same batch (id `pm-<location>`, matching resolvePrivateMenus), pointed at by
		// the location's menu_id. The menu row must precede the location INSERT that
		// references it (immediate FK).
		const privateMenuId = hasItems ? `pm-${id}` : null;
		if (privateMenuId) {
			stmts.push(
				db
					.prepare(
						`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, NULL)`
					)
					.bind(privateMenuId, loc.name, loc.currency ?? DEFAULT_CURRENCY)
			);
		}
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, brand_id, menu_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					loc.name,
					loc.category,
					loc.latitude,
					loc.longitude,
					loc.street,
					loc.city,
					loc.region,
					loc.postcode,
					loc.country,
					loc.phone,
					loc.website,
					loc.brand_id ?? null,
					loc.menu_id ?? privateMenuId
				)
		);
		for (const source of loc.sources ?? []) {
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
					)
					.bind(id, source.url, source.label ?? null)
			);
		}
		if (privateMenuId) {
			for (const item of loc.items ?? []) {
				stmts.push(...insertItemStmts(db, item.id ?? crypto.randomUUID(), privateMenuId, item));
			}
		}
	}
	await db.batch(stmts);
	return ids;
}

/** Mutable columns of `locations`. */
const LOCATION_COLUMNS = [
	'name',
	'category',
	'latitude',
	'longitude',
	'street',
	'city',
	'region',
	'postcode',
	'country',
	'phone',
	'website',
	'brand_id',
	'menu_id'
] as const;

/** A partial update to one location, keyed by id (for {@link updateLocations}). */
export type LocationPatch = Partial<Omit<Location, 'id' | 'address'>> & {
	id: string;
	/** Append these sources (dedupe by url), keeping existing ones — vs `sources` which replaces. */
	addSources?: Source[];
};

/**
 * Statements that apply one location patch: the scalar SET (only the columns
 * present in `patch`) and, when `patch.sources` is given, a full source-set
 * replacement (pass `[]` to clear). No existence check — {@link updateLocations}
 * resolves which ids exist up front so the whole batch stays a single round trip.
 */
function locationUpdateStmts(db: D1Like, patch: LocationPatch): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];
	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of LOCATION_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col]);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db
				.prepare(`UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`)
				.bind(...values, patch.id)
		);
	}
	// `sources` replaces the whole set; `addSources` appends (dedupe via the PK).
	const replace = patch.sources !== undefined;
	if (replace) {
		stmts.push(db.prepare(`DELETE FROM location_sources WHERE location_id = ?`).bind(patch.id));
	}
	const toAdd = replace ? patch.sources : patch.addSources;
	for (const source of toAdd ?? []) {
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
				)
				.bind(patch.id, source.url, source.label ?? null)
		);
	}
	return stmts;
}

/**
 * Applies many partial location updates in one atomic batch. Each patch touches
 * only the fields it carries; a `sources` array replaces that location's whole
 * source set (`[]` clears it). Ids that don't exist are skipped and reported in
 * `notFoundIds` rather than aborting the batch. Returns which ids were updated and
 * which were not found. Ideal for mass backfills from the address/coordinate
 * audits — one round trip instead of one update call per location.
 */
export async function updateLocations(
	db: D1Like,
	patches: LocationPatch[]
): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
	if (patches.length === 0) return { updatedIds: [], notFoundIds: [] };
	const ids = patches.map((p) => p.id);
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT id FROM locations WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<{ id: string }>();
	const existing = new Set(results.map((r) => r.id));

	const updatedIds: string[] = [];
	const notFoundIds: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const patch of patches) {
		if (!existing.has(patch.id)) {
			notFoundIds.push(patch.id);
			continue;
		}
		updatedIds.push(patch.id);
		stmts.push(...locationUpdateStmts(db, patch));
	}
	if (stmts.length > 0) await db.batch(stmts);
	return { updatedIds, notFoundIds };
}

export async function deleteLocation(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM locations WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Writes — items on a venue's own (private) menu  [create_items, location_id path]
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertFoods}. */
export type FoodInsert = {
	id?: string;
	location_id: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
	tags?: TagId[];
	optionalTags?: TagId[];
	ingredients?: string | null;
	optionalIngredients?: string | null;
	sources?: Source[];
};

/**
 * Resolves the private menu each given location writes its own items to, creating
 * one (and pointing the location at it) where the location has no menu yet.
 * Returns a map of location_id → private menu_id, plus the create/link statements
 * to run before the item inserts. Throws if a location is missing, or if it
 * already serves a SHARED brand menu (a chain branch has no per-branch item store
 * — edit the shared menu or use an override instead).
 */
async function resolvePrivateMenus(
	db: D1Like,
	locationIds: string[],
	currency: string = DEFAULT_CURRENCY
): Promise<{ menuByLocation: Map<string, string>; stmts: D1PreparedLike[] }> {
	const menuByLocation = new Map<string, string>();
	const stmts: D1PreparedLike[] = [];
	const owners = await Promise.all(
		locationIds.map((locationId) =>
			db
				.prepare(
					`SELECT l.id AS id, l.name AS name, l.menu_id AS menu_id, m.brand_id AS brand_id
					 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
					 WHERE l.id = ?`
				)
				.bind(locationId)
				.first<{ id: string; name: string; menu_id: string | null; brand_id: string | null }>()
		)
	);
	owners.forEach((owner, i) => {
		const locationId = locationIds[i];
		if (!owner) throw new Error(`No location with id "${locationId}".`);
		if (owner.menu_id !== null) {
			if (owner.brand_id !== null) {
				throw new Error(
					`Location "${locationId}" serves a shared chain menu; its menu items are shared across ` +
						`the chain. Edit them with update_items, or record a per-branch difference with ` +
						`set_location_item_override.`
				);
			}
			menuByLocation.set(locationId, owner.menu_id);
			return;
		}
		// No menu yet: create a private one (brand_id NULL) and point the location at it.
		const menuId = `pm-${locationId}`;
		menuByLocation.set(locationId, menuId);
		stmts.push(
			db
				.prepare(
					`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, NULL)`
				)
				.bind(menuId, owner.name, currency),
			db.prepare(`UPDATE locations SET menu_id = ? WHERE id = ?`).bind(menuId, locationId)
		);
	});
	return { menuByLocation, stmts };
}

/**
 * Inserts many items belonging to independent venues (their own private menus),
 * in one atomic batch, returning their ids in input order. Each item's
 * `ingredients` string is stored as ingredient tags. A venue with no menu yet
 * gets a private menu created for it automatically; `currency` (default CAD) sets
 * that new menu's currency (ignored for a venue whose private menu already exists).
 */
export async function insertFoods(
	db: D1Like,
	items: FoodInsert[],
	currency: string = DEFAULT_CURRENCY
): Promise<string[]> {
	const locationIds = [...new Set(items.map((it) => it.location_id))];
	const { menuByLocation, stmts: menuStmts } = await resolvePrivateMenus(db, locationIds, currency);

	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [...menuStmts];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		const menuId = menuByLocation.get(item.location_id);
		// resolvePrivateMenus populates an entry for every distinct location_id (or
		// throws), so this is always defined; the guard just narrows the type.
		if (menuId === undefined)
			throw new Error(`No menu resolved for location "${item.location_id}".`);
		stmts.push(...insertItemStmts(db, id, menuId, item));
	}
	await db.batch(stmts);
	return ids;
}

/**
 * Statements that apply one item patch: the scalar SET (only the columns present
 * in `patch`), plus full-set replacements for the dietary/course tags, the
 * ingredient tags and the sources when those are provided (`tags: []`/
 * `ingredients: ''`/`sources: []` clear; `addSources` appends instead of replacing).
 * No existence check — callers ({@link updateItem}, {@link updateItems}) resolve which
 * ids exist up front so a whole batch stays a single round trip.
 */
function itemUpdateStmts(db: D1Like, id: string, patch: ItemUpdate): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of ['menu_id', 'item_name', 'description', 'price'] as const) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(value);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE items SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}

	// Replace the dietary/course tag set (leaving ingredient tags untouched).
	if (patch.tags !== undefined || patch.optionalTags !== undefined) {
		stmts.push(
			db
				.prepare(
					`DELETE FROM item_tags WHERE item_id = ? AND tag_id IN
					 (SELECT id FROM tags WHERE tag_type IN ('dietary', 'course'))`
				)
				.bind(id)
		);
		for (const tagId of patch.tags ?? []) stmts.push(linkTagStmt(db, id, tagId, 0));
		for (const tagId of patch.optionalTags ?? []) stmts.push(linkTagStmt(db, id, tagId, 1));
	}

	// Replace the ingredient tag set (leaving dietary/course tags untouched).
	if (patch.ingredients !== undefined || patch.optionalIngredients !== undefined) {
		stmts.push(
			db
				.prepare(
					`DELETE FROM item_tags WHERE item_id = ? AND tag_id IN
					 (SELECT id FROM tags WHERE tag_type = 'ingredient')`
				)
				.bind(id)
		);
		for (const name of parseIngredients(patch.ingredients))
			stmts.push(...ingredientLinkStmts(db, id, name, 0));
		for (const name of parseIngredients(patch.optionalIngredients))
			stmts.push(...ingredientLinkStmts(db, id, name, 1));
	}

	if (patch.sources !== undefined) {
		stmts.push(db.prepare(`DELETE FROM item_sources WHERE item_id = ?`).bind(id));
		stmts.push(...sourceLinkStmts(db, id, patch.sources));
	} else if (patch.addSources !== undefined) {
		// Append-only: existing sources stay; INSERT OR IGNORE dedupes by (item_id, url).
		stmts.push(...sourceLinkStmts(db, id, patch.addSources));
	}

	return stmts;
}

/**
 * Applies a partial update to an item (a row in `items`), returning the updated
 * item or `null` if no item has that id. See {@link itemUpdateStmts} for the
 * replace-set semantics; all sub-statements run as one atomic batch.
 */
async function applyItemUpdate(db: D1Like, id: string, patch: ItemUpdate): Promise<Item | null> {
	if (!(await getItemById(db, id))) return null;
	const stmts = itemUpdateStmts(db, id, patch);
	if (stmts.length > 0) await db.batch(stmts);
	return getItemById(db, id);
}

// ---------------------------------------------------------------------------
// Brands (chains)
// ---------------------------------------------------------------------------

export async function getBrands(db: D1Like): Promise<Brand[]> {
	const { results } = await db
		.prepare(`SELECT id, name, website, logo_url FROM brands ORDER BY name`)
		.all<Brand>();
	return results;
}

export async function getBrandById(db: D1Like, id: string): Promise<Brand | null> {
	return db
		.prepare(`SELECT id, name, website, logo_url FROM brands WHERE id = ?`)
		.bind(id)
		.first<Brand>();
}

/** Ids of brands whose name matches `name` (case-insensitive). Used to flag a likely duplicate. */
export async function findBrandIdsByName(db: D1Like, name: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM brands WHERE name = ? COLLATE NOCASE ORDER BY id`)
		.bind(name)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

export async function insertBrand(
	db: D1Like,
	brand: Omit<Brand, 'id'> & { id?: string }
): Promise<string> {
	const id = brand.id ?? crypto.randomUUID();
	await db
		.prepare(`INSERT INTO brands (id, name, website, logo_url) VALUES (?, ?, ?, ?)`)
		.bind(id, brand.name, brand.website ?? null, brand.logo_url ?? null)
		.run();
	return id;
}

const BRAND_COLUMNS = ['name', 'website', 'logo_url'] as const;

/** Partial update of a brand. Returns the updated row, or `null` if id unknown. */
export async function updateBrand(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Brand, 'id'>>
): Promise<Brand | null> {
	const assignments: string[] = [];
	const values: (string | null)[] = [];
	for (const col of BRAND_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col] ?? null);
		}
	}
	if (assignments.length > 0) {
		await db
			.prepare(`UPDATE brands SET ${assignments.join(', ')} WHERE id = ?`)
			.bind(...values, id)
			.run();
	}
	return getBrandById(db, id);
}

/**
 * Deletes a brand and (by cascade) its menus, their items and tag/source links.
 * Any locations referencing it revert to having no menu (`brand_id`/`menu_id` set
 * to NULL by `ON DELETE SET NULL`). Returns `true` if a row was removed.
 */
export async function deleteBrand(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM brands WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** Internal raw shape of a `menus` row before its sources are attached. */
type MenuRow = Omit<Menu, 'sources'>;

const MENU_FIELDS = `id, brand_id, name, region, currency, last_verified`;

/**
 * Lists brand menus (with an item count), optionally filtered by brand. Private
 * venue menus (brand_id NULL) are an implementation detail and excluded.
 */
export async function getMenus(db: D1Like, brandId?: string): Promise<MenuSummary[]> {
	const sql =
		`SELECT m.id, m.brand_id, m.name, m.region, m.currency, m.last_verified, COUNT(i.id) AS item_count
		 FROM menus m LEFT JOIN items i ON i.menu_id = m.id` +
		(brandId ? ` WHERE m.brand_id = ?` : ` WHERE m.brand_id IS NOT NULL`) +
		` GROUP BY m.id ORDER BY m.name`;
	const stmt = brandId ? db.prepare(sql).bind(brandId) : db.prepare(sql);
	const { results } = await stmt.all<MenuSummary>();
	return results;
}

export async function getMenuById(db: D1Like, id: string): Promise<Menu | null> {
	const [row, { results: sources }] = await Promise.all([
		db.prepare(`SELECT ${MENU_FIELDS} FROM menus WHERE id = ?`).bind(id).first<MenuRow>(),
		db
			.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	return { ...row, sources };
}

/**
 * Ids of menus belonging to `brandId` whose name matches `name` (case-insensitive).
 * Used to flag a likely duplicate when creating another menu under the same brand.
 */
export async function findMenuIdsByName(
	db: D1Like,
	brandId: string,
	name: string
): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM menus WHERE brand_id = ? AND name = ? COLLATE NOCASE ORDER BY id`)
		.bind(brandId, name)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

export async function getMenuWithItems(db: D1Like, id: string): Promise<MenuWithItems | null> {
	const menu = await getMenuById(db, id);
	if (!menu) return null;
	return { ...menu, items: await getItemsByMenu(db, id) };
}

export async function insertMenu(
	db: D1Like,
	menu: Omit<Menu, 'id' | 'sources' | 'currency'> & {
		id?: string;
		currency?: string;
		sources?: Source[];
	}
): Promise<string> {
	const id = menu.id ?? crypto.randomUUID();
	const stmts: D1PreparedLike[] = [
		db
			.prepare(
				`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				menu.brand_id ?? null,
				menu.name,
				menu.region ?? null,
				menu.currency ?? DEFAULT_CURRENCY,
				menu.last_verified ?? null
			)
	];
	for (const source of menu.sources ?? []) {
		stmts.push(
			db
				.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
				.bind(id, source.url, source.label ?? null)
		);
	}
	await db.batch(stmts);
	return id;
}

const MENU_COLUMNS = ['brand_id', 'name', 'region', 'currency', 'last_verified'] as const;

/**
 * Partial update of a menu. Scalar fields present in `patch` are written; if
 * `patch.sources` is given it replaces the whole source set (pass `[]` to clear).
 * Returns the updated menu, or `null` if no menu has that id.
 */
export async function updateMenu(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Menu, 'id'>> & {
		/** Append these sources (dedupe by url), keeping existing ones — vs `sources` which replaces. */
		addSources?: Source[];
	}
): Promise<Menu | null> {
	if (!(await getMenuById(db, id))) return null;

	const stmts: D1PreparedLike[] = [];
	const assignments: string[] = [];
	const values: (string | null)[] = [];
	for (const col of MENU_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col] ?? null);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE menus SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}
	// `sources` replaces the whole set; `addSources` appends (dedupe via the PK).
	const replaceSources = patch.sources !== undefined;
	if (replaceSources) {
		stmts.push(db.prepare(`DELETE FROM menu_sources WHERE menu_id = ?`).bind(id));
	}
	for (const source of (replaceSources ? patch.sources : patch.addSources) ?? []) {
		stmts.push(
			db
				.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
				.bind(id, source.url, source.label ?? null)
		);
	}
	if (stmts.length > 0) await db.batch(stmts);
	return getMenuById(db, id);
}

/**
 * Deletes a menu and (by cascade) its items and their tag/source links. Any
 * locations serving it revert to having no menu (`menu_id` set NULL). Returns
 * `true` if a row was removed.
 */
export async function deleteMenu(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM menus WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Shared menu items (belong to a menu — cf. the create_items location_id path, which adds
// to a venue's own private menu). Both write to the same `items` table. Reading,
// updating and deleting a single item are id-keyed and menu-agnostic, so they use
// the generic getItemById / updateItem / deleteItem rather than a per-kind variant.
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertMenuItems}. */
export type MenuItemInsert = {
	id?: string;
	menu_id: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
	tags?: TagId[];
	optionalTags?: TagId[];
	ingredients?: string | null;
	optionalIngredients?: string | null;
	sources?: Source[];
};

/**
 * Inserts many shared menu items in one atomic batch and returns their ids in
 * input order. Mirrors {@link insertFoods}, but items belong to a given menu
 * (shared across every location that serves it) rather than a venue's own menu.
 */
export async function insertMenuItems(db: D1Like, items: MenuItemInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		stmts.push(...insertItemStmts(db, id, item.menu_id, item));
	}
	await db.batch(stmts);
	return ids;
}

/**
 * Of the given item names, those that ALREADY exist on `menuId` (case-insensitive),
 * each with the existing item ids. Lets create_items warn that a
 * re-run or extend would duplicate an item the menu already lists, so an agent can
 * update the existing item instead. Returns `[]` when nothing collides.
 */
export async function itemNameCollisions(
	db: D1Like,
	menuId: string,
	names: string[]
): Promise<{ item_name: string; existing_ids: string[] }[]> {
	const distinct = [...new Set(names)];
	if (distinct.length === 0) return [];
	const placeholders = distinct.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT id, item_name FROM items WHERE menu_id = ? AND item_name COLLATE NOCASE IN (${placeholders})`
		)
		.bind(menuId, ...distinct)
		.all<{ id: string; item_name: string }>();
	const idsByLowerName = new Map<string, string[]>();
	for (const r of results) {
		const key = r.item_name.toLowerCase();
		const list = idsByLowerName.get(key) ?? [];
		list.push(r.id);
		idsByLowerName.set(key, list);
	}
	const out: { item_name: string; existing_ids: string[] }[] = [];
	for (const name of distinct) {
		const ids = idsByLowerName.get(name.toLowerCase());
		if (ids?.length) out.push({ item_name: name, existing_ids: ids });
	}
	return out;
}

/** Arguments accepted by {@link updateItem}. */
export type ItemUpdate = {
	/** Move the item to a different menu (rare). */
	menu_id?: string;
	item_name?: string;
	description?: string | null;
	price?: number | null;
	/** Append these sources (dedupe by url), keeping existing ones — vs `sources` which replaces. */
	addSources?: Source[];
} & ItemContent;

/**
 * Partial update of an item by id. For a shared chain item the change applies to
 * EVERY branch serving its menu; for a venue's own item it applies to that venue.
 * See {@link applyItemUpdate} for the replace-set semantics of tags/ingredients/sources.
 */
export async function updateItem(db: D1Like, id: string, patch: ItemUpdate): Promise<Item | null> {
	return applyItemUpdate(db, id, patch);
}

/** A partial update to one item, keyed by id (for {@link updateItems}). */
export type ItemPatch = ItemUpdate & { id: string };

/**
 * Applies many partial item updates in one atomic batch — the multi-item sibling of
 * {@link updateItem}, mirroring {@link updateLocations}. Each patch touches only the
 * fields it carries (same replace-set semantics; see {@link itemUpdateStmts}). Ids that
 * don't exist are skipped and reported in `notFoundIds` rather than aborting the batch.
 * Returns which ids were updated and which were not found — one round trip instead of a
 * call per item, for menu-wide corrections.
 */
export async function updateItems(
	db: D1Like,
	patches: ItemPatch[]
): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
	if (patches.length === 0) return { updatedIds: [], notFoundIds: [] };
	const ids = patches.map((p) => p.id);
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT id FROM items WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<{ id: string }>();
	const existing = new Set(results.map((r) => r.id));

	const updatedIds: string[] = [];
	const notFoundIds: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const { id, ...patch } of patches) {
		if (!existing.has(id)) {
			notFoundIds.push(id);
			continue;
		}
		updatedIds.push(id);
		stmts.push(...itemUpdateStmts(db, id, patch));
	}
	if (stmts.length > 0) await db.batch(stmts);
	return { updatedIds, notFoundIds };
}

/** Deletes an item and its tag/source links (and any per-location overrides). Returns `true` if removed. */
export async function deleteItem(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM items WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Per-location overrides of menu items
// ---------------------------------------------------------------------------

/** Returns a location's overrides of its menu items (empty if none). */
export async function getLocationItemOverrides(
	db: D1Like,
	locationId: string
): Promise<LocationItemOverride[]> {
	const { results } = await db
		.prepare(
			`SELECT location_id, item_id, available, price
			 FROM location_item_overrides WHERE location_id = ? ORDER BY rowid`
		)
		.bind(locationId)
		.all<OverrideRow>();
	return results.map((r) => ({
		location_id: r.location_id,
		item_id: r.item_id,
		available: r.available === null ? null : r.available !== 0,
		price: r.price
	}));
}

/**
 * Creates or updates a location's override of one menu item as a PARTIAL PATCH:
 * only the fields PRESENT in `override` change. A field left `undefined` keeps its
 * currently-stored value (so toggling just `available` no longer wipes a previously
 * set `price`, and vice-versa); pass an explicit `null` to reset that field to
 * inherit the menu default. `available` `false` hides the item at this location;
 * `price` overrides its price here.
 */
export async function setLocationItemOverride(
	db: D1Like,
	locationId: string,
	itemId: string,
	override: { available?: boolean | null; price?: number | null }
): Promise<{ available: boolean | null; price: number | null }> {
	// Merge with the existing row so an omitted field is preserved, not cleared.
	const existing = await db
		.prepare(
			`SELECT available, price FROM location_item_overrides WHERE location_id = ? AND item_id = ?`
		)
		.bind(locationId, itemId)
		.first<{ available: number | null; price: number | null }>();
	const available =
		override.available !== undefined
			? override.available === null
				? null
				: override.available
					? 1
					: 0
			: (existing?.available ?? null);
	const price = override.price !== undefined ? (override.price ?? null) : (existing?.price ?? null);
	await db
		.prepare(
			`INSERT INTO location_item_overrides (location_id, item_id, available, price)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(location_id, item_id)
			 DO UPDATE SET available = excluded.available, price = excluded.price`
		)
		.bind(locationId, itemId, available, price)
		.run();
	// Return the resulting (merged) override so callers can echo accurate state.
	return { available: available === null ? null : available !== 0, price };
}

/** Removes an override so the location inherits the menu default again. */
export async function deleteLocationItemOverride(
	db: D1Like,
	locationId: string,
	itemId: string
): Promise<boolean> {
	const res = await db
		.prepare(`DELETE FROM location_item_overrides WHERE location_id = ? AND item_id = ?`)
		.bind(locationId, itemId)
		.run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Users, sessions, likes and search history (the user-owned data added by
// migration 0007). Unlike everything above — curated map data written by the MCP
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

/** The ids a user has liked, newest first. */
export interface UserLikes {
	locationIds: string[];
	itemIds: string[];
}

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
	const existing = await getUserByOAuth(db, provider, providerUserId);
	if (existing) {
		await db
			.prepare(`UPDATE users SET email = ?, email_verified = ?, name = ?, picture = ? WHERE id = ?`)
			.bind(profile.email, verified, profile.name, profile.picture, existing.id)
			.run();
		return { ...existing, ...profile };
	}
	const id = crypto.randomUUID();
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO users (id, email, email_verified, name, picture, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(id, profile.email, verified, profile.name, profile.picture, now),
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
	return { id, ...profile };
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

/** Loads a session and its user in one read (the per-request auth lookup), or null. */
export async function getSessionWithUser(
	db: D1Like,
	sessionId: string
): Promise<{ session: Session; user: User } | null> {
	const row = await db
		.prepare(
			`SELECT s.id AS session_id, s.user_id AS user_id, s.expires_at AS expires_at,
				u.email AS email, u.email_verified AS email_verified, u.name AS name, u.picture AS picture
			 FROM sessions s JOIN users u ON u.id = s.user_id
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
		}>();
	if (!row) return null;
	return {
		session: { id: row.session_id, user_id: row.user_id, expires_at: row.expires_at },
		user: toUser({
			id: row.user_id,
			email: row.email,
			email_verified: row.email_verified,
			name: row.name,
			picture: row.picture
		})
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

/** Returns a user's liked location and item ids, newest first. */
export async function getUserLikes(db: D1Like, userId: string): Promise<UserLikes> {
	const [{ results: locs }, { results: items }] = await Promise.all([
		db
			.prepare(`SELECT location_id FROM liked_locations WHERE user_id = ? ORDER BY created_at DESC`)
			.bind(userId)
			.all<{ location_id: string }>(),
		db
			.prepare(`SELECT item_id FROM liked_items WHERE user_id = ? ORDER BY created_at DESC`)
			.bind(userId)
			.all<{ item_id: string }>()
	]);
	return {
		locationIds: locs.map((r) => r.location_id),
		itemIds: items.map((r) => r.item_id)
	};
}

/** Likes (or, when `liked` is false, unlikes) a location for a user. Idempotent. */
export async function setLocationLike(
	db: D1Like,
	userId: string,
	locationId: string,
	liked: boolean,
	now: number
): Promise<void> {
	if (liked) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO liked_locations (user_id, location_id, created_at) VALUES (?, ?, ?)`
			)
			.bind(userId, locationId, now)
			.run();
	} else {
		await db
			.prepare(`DELETE FROM liked_locations WHERE user_id = ? AND location_id = ?`)
			.bind(userId, locationId)
			.run();
	}
}

/** Likes (or, when `liked` is false, unlikes) a menu item for a user. Idempotent. */
export async function setItemLike(
	db: D1Like,
	userId: string,
	itemId: string,
	liked: boolean,
	now: number
): Promise<void> {
	if (liked) {
		await db
			.prepare(`INSERT OR IGNORE INTO liked_items (user_id, item_id, created_at) VALUES (?, ?, ?)`)
			.bind(userId, itemId, now)
			.run();
	} else {
		await db
			.prepare(`DELETE FROM liked_items WHERE user_id = ? AND item_id = ?`)
			.bind(userId, itemId)
			.run();
	}
}

/** One search to log. Tag lists are stored verbatim as JSON for rehydration. */
export interface SearchLogEntry {
	id: string;
	userId: string;
	place: string;
	item: string;
	included: Tag[];
	excluded: Tag[];
	createdAt: number;
}

/** Appends a search to the user's history. Uncapped — see migration 0007. */
export async function logSearch(db: D1Like, entry: SearchLogEntry): Promise<void> {
	await db
		.prepare(
			`INSERT INTO search_history
				(id, user_id, place, item, included_tags, excluded_tags, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			entry.id,
			entry.userId,
			entry.place,
			entry.item,
			JSON.stringify(entry.included),
			JSON.stringify(entry.excluded),
			entry.createdAt
		)
		.run();
}

/**
 * Hard cap on how many tag suggestions {@link getTagSuggestions} returns for one
 * picker — bounding both the default (empty-query) list and the popularity
 * re-rank of typed results. Mirrored on the client only to size the rank map;
 * this module stays the source of truth for the value.
 */
export const TAG_SUGGESTION_LIMIT = 30;

/** Which half of the tag filter a suggestion is for: the include set or the exclude set. */
export type TagFilterMode = 'include' | 'exclude';

/**
 * Suggests tags for one tag-filter picker, mined from the searches users have run
 * ({@link logSearch}). For `mode` it reads that column of `search_history`
 * (`included_tags` for 'include', `excluded_tags` for 'exclude'), so the two
 * pickers draw on SEPARATE popularity pools — a tag people frequently EXCLUDE
 * doesn't bubble up in the INCLUDE picker.
 *
 * Ordering: the signed-in user's own tags in this mode first, most-recently-used
 * first; then the globally most-searched tags in this mode by frequency; then
 * alphabetical as a stable tiebreak. De-duplicated across the two tiers and
 * capped at {@link TAG_SUGGESTION_LIMIT}. A null `userId` (signed out) drops the
 * personal tier, leaving just the global popularity ranking.
 *
 * Each stored tag is JSON ({id,name,tag_type}); `json_each` expands the array and
 * each element is JOINed to the live `tags` row by id — so a tag since deleted is
 * dropped, and a since-renamed one shows its current name. The tag pickers are the
 * only consumer; an empty result (a fresh database with no matching history) is
 * expected and simply surfaces nothing until searches accrue.
 */
export async function getTagSuggestions(
	db: D1Like,
	userId: string | null,
	mode: TagFilterMode,
	limit = TAG_SUGGESTION_LIMIT
): Promise<Tag[]> {
	// The column is a trusted literal chosen by `mode`, never user input, so it is
	// interpolated (matching the LIMIT convention in this module); the user id and
	// every other user value below is bound.
	const column = mode === 'include' ? 'included_tags' : 'excluded_tags';
	const safeLimit = Math.max(0, Math.trunc(limit));
	if (safeLimit === 0) return [];

	// Global popularity in this mode: expand each logged search's JSON tag array,
	// tally rows by tag id, and resolve each to its live tag row.
	const popularStmt = db.prepare(
		`SELECT t.id AS id, t.name AS name, t.tag_type AS tag_type, COUNT(*) AS n
		 FROM search_history sh, json_each(sh.${column}) j
		 JOIN tags t ON t.id = json_extract(j.value, '$.id')
		 GROUP BY t.id
		 ORDER BY n DESC, t.name
		 LIMIT ${safeLimit}`
	);

	// The signed-in user's own tags in this mode, most-recently-used first.
	const recentStmt =
		userId === null
			? null
			: db
					.prepare(
						`SELECT t.id AS id, t.name AS name, t.tag_type AS tag_type,
						        MAX(sh.created_at) AS last_used
						 FROM search_history sh, json_each(sh.${column}) j
						 JOIN tags t ON t.id = json_extract(j.value, '$.id')
						 WHERE sh.user_id = ?
						 GROUP BY t.id
						 ORDER BY last_used DESC
						 LIMIT ${safeLimit}`
					)
					.bind(userId);

	const [{ results: popular }, recent] = await Promise.all([
		popularStmt.all<Tag & { n: number }>(),
		recentStmt
			? recentStmt.all<Tag & { last_used: number }>().then((r) => r.results)
			: Promise.resolve<Tag[]>([])
	]);

	// Personal-recent first, then global-popular, de-duplicated, capped. Strip the
	// ranking columns (n / last_used) back to a bare Tag.
	const merged: Tag[] = [];
	const seen = new Set<string>();
	for (const tag of [...recent, ...popular]) {
		if (seen.has(tag.id)) continue;
		seen.add(tag.id);
		merged.push({ id: tag.id, name: tag.name, tag_type: tag.tag_type });
		if (merged.length >= safeLimit) break;
	}
	return merged;
}
