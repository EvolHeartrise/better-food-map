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
// Value imports (tiny, pure, client-safe): the canonical display-address formatter,
// so the single-line `address` is composed identically wherever a location is read,
// and the canonical tag vocabulary.
import { TAGS, dietFilterTagIds, impliedDietTagIds } from '../tags';
import { formatAddress } from '../address';
import { decodeHtmlEntities } from '../text';
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
	/** Tags applied to this item (dietary and course), with `optional`. */
	tags: ItemTag[];
}

/**
 * A menu item, in full. Belongs to a {@link Menu} — private to one venue, or
 * shared across a chain's branches.
 */
export interface Item extends MapItem {
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
	 * mirroring the likes term of the server's per-cell ranking
	 * ({@link getMapCellsData}). Derived from the like count but deliberately
	 * named opaquely on the wire: the payload is public, and this shouldn't
	 * read as (or be relied on as) an exact like tally.
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
	 */
	menuMeta: Record<string, { last_verified: string | null; sources: Source[] }>;
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

/**
 * Today's date as an ISO `YYYY-MM-DD` string in the LOCAL timezone. Used as the
 * default {@link Menu.last_verified} when a menu is created without one — every
 * menu must carry a verification date (enforced by the triggers in migration
 * 0012), and a just-created menu is "verified as of now". Local (not UTC) so an
 * evening write from the MCP server doesn't stamp tomorrow's date; on the Worker
 * (whose runtime timezone is UTC) the two are identical. The app supplies this
 * rather than a SQLite `DEFAULT (date('now'))`, matching the convention of
 * keeping time out of the schema (see migration 0007).
 */
export function currentVerificationDate(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Statements that stamp each given menu's `last_verified` to today. Every MCP write
 * that adds or changes a menu or its items runs this, so a menu's freshness date
 * always reflects the last time data flowed into it — agents never supply the date
 * by hand (it is not a tool parameter). Ids are de-duplicated, and the valid
 * date satisfies migration 0012's non-empty-`last_verified` trigger. Returns `[]`
 * for an empty id set so callers can splice it into a batch unconditionally.
 */
function touchMenuStmts(db: D1Like, menuIds: Iterable<string>): D1PreparedLike[] {
	const today = currentVerificationDate();
	return [...new Set(menuIds)].map((menuId) =>
		db.prepare(`UPDATE menus SET last_verified = ? WHERE id = ?`).bind(today, menuId)
	);
}

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
type ItemRow = Omit<Item, 'tags' | 'currency'>;

/** Raw `location_item_overrides` row (`available` stored as 0/1/NULL). */
interface OverrideRow {
	location_id: string;
	item_id: string;
	available: number | null;
	price: number | null;
}

/** Internal raw shape of a `locations` row before its derived `address` is attached. */
// The raw DB row: the structured columns, but not the derived `address` (composed on read).
type LocationRow = Omit<Location, 'address'>;

/** Raw `menu_sources` row keyed by its owner menu id. */
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

// ---------------------------------------------------------------------------
// SQL (D1 enforces foreign keys; schema lives in migrations/)
// ---------------------------------------------------------------------------

const LOCATION_FIELDS = `id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, brand_id, menu_id`;
const ITEM_FIELDS = `id, menu_id, item_name, description, price`;
/** The lean {@link MapItem} projection the bulk viewport/search reads use (#83). */
const MAP_ITEM_FIELDS = `id, menu_id, item_name`;
/** Item-tag join projection (aliased to {@link ItemTagRow}). */
const ITEM_TAG_SELECT = `t.id AS id, t.name AS name, t.tag_type AS tag_type, it.optional AS optional`;

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
 * Optional server-side filters for {@link getLocationsWithTags}, pushed into SQL
 * so a bounded list doesn't read (and ship) the whole table. `bbox` and
 * `category` narrow the rows; `limit`/`offset` page the name-ordered result, and
 * the joined tag read is keyed to the returned page's ids. A radius query is served by passing the
 * covering `bbox` and refining to the exact circle in the caller, so this layer
 * stays geo-free. With no filter the behaviour is unchanged (every location).
 */
export interface LocationListFilter {
	bbox?: Bounds;
	category?: Category;
	/** Case-insensitive substring match on the location name (LIKE %query%). */
	nameLike?: string;
	/** Only branches of this chain (exact brand_id match). */
	brandId?: string;
	limit?: number;
	offset?: number;
}

/**
 * Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`). When the
 * result equals the input, nothing needed escaping — the pattern then carries no
 * escape character, so the `ESCAPE` clause may be omitted without changing what
 * the LIKE matches (searchMembership relies on this to keep the FTS5 trigram
 * pushdown, which an ESCAPE clause would disable — see migration 0016).
 */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Builds the WHERE predicates (aliased to `l`) + bind params for a
 * {@link LocationListFilter}. Closed (soft-deleted) venues are always excluded
 * (migration 0015); that literal carries no bind param, so `params` alignment is
 * untouched. Shared by {@link getLocationsWithTags} and {@link countLocations}
 * so a list and its count always agree on which rows qualify.
 */
function locationFilterConds(filter: LocationListFilter): {
	conds: string[];
	params: (string | number)[];
} {
	const conds: string[] = ['l.closed_at IS NULL'];
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
	if (filter.brandId) {
		conds.push('l.brand_id = ?');
		params.push(filter.brandId);
	}
	return { conds, params };
}

/** How many OPEN locations match `filter` — the cheap companion to a paged list. */
export async function countLocations(db: D1Like, filter: LocationListFilter = {}): Promise<number> {
	const { conds, params } = locationFilterConds(filter);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM locations l WHERE ${conds.join(' AND ')}`)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function getLocationsWithTags(
	db: D1Like,
	filter: LocationListFilter = {}
): Promise<LocationWithTags[]> {
	// The filter (and its paging) is evaluated exactly once — the location-row
	// read; the tag sub-read is then keyed by the ids that read returned,
	// so its cost is bounded by the PAGE size, not the full filter-match set
	// (the same id-first shape queryMapData uses, #80/#92).
	const { conds, params } = locationFilterConds(filter);
	const whereSql = `WHERE ${conds.join(' AND ')}`;
	// LIMIT/OFFSET are trusted integers → interpolated (matching MAP_RESULT_LIMIT).
	let pagingSql = '';
	if (filter.limit !== undefined) pagingSql = ` LIMIT ${Math.max(0, Math.trunc(filter.limit))}`;
	else if (filter.offset) pagingSql = ' LIMIT -1';
	if (filter.offset) pagingSql += ` OFFSET ${Math.max(0, Math.trunc(filter.offset))}`;

	const { results: locations } = await db
		.prepare(`SELECT ${LOCATION_FIELDS} FROM locations l ${whereSql} ORDER BY l.name${pagingSql}`)
		.bind(...params)
		.all<LocationRow>();
	if (locations.length === 0) return [];

	// One JSON-array bind expanded with json_each — never an `IN (?, …)` list,
	// which would blow D1's ~100 per-query bound-parameter cap on an unpaged read
	// (the `near` path calls this with no limit).
	const idsJson = JSON.stringify(locations.map((l) => l.id));
	const { results: tagRows } = await db
		// Distinct dietary/course tags offered across a location's menu, excluding
		// items it has overridden to unavailable.
		.prepare(
			`SELECT DISTINCT l.id AS owner_id, t.id AS id, t.name AS name, t.tag_type AS tag_type
			 FROM locations l
			 JOIN items i ON i.menu_id = l.menu_id
			 JOIN item_tags it ON it.item_id = i.id
			 JOIN tags t ON t.id = it.tag_id
			 LEFT JOIN location_item_overrides o
				ON o.location_id = l.id AND o.item_id = i.id
			 WHERE l.id IN (SELECT value FROM json_each(?))
				AND l.menu_id IS NOT NULL
				AND t.tag_type IN ('dietary', 'course')
				AND (o.available IS NULL OR o.available <> 0)
			 ORDER BY l.id, t.rowid`
		)
		.bind(idsJson)
		.all<LocationTagRow>();

	const tagsByLocation = groupLocationTagsDistinct(tagRows);

	return locations.map((loc) => ({
		...loc,
		address: formatAddress(loc),
		tags: tagsByLocation.get(loc.id) ?? []
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
	// One JSON-array bind expanded with json_each, never an `IN (?, …)` list: the MCP
	// create tools batch well past D1's ~100 per-query bound-parameter limit (an
	// exhaustive create_items menu can carry hundreds of explicit ids).
	const { results } = await db
		.prepare(`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
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
	// The pairs travel as ONE JSON array of [lat, lng] tuples expanded with json_each —
	// per-pair `(latitude = ? AND longitude = ?)` conditions cost two bound parameters
	// each, so a 100-location create_locations batch would blow D1's ~100 per-query
	// parameter limit. json_extract parses a JSON.stringify'd JS double back to the
	// bit-identical REAL, so the equality stays float-EXACT — the coordinate-identical
	// dedup invariant this function exists for is untouched.
	const pairs = JSON.stringify(distinct.map((c) => [c.latitude, c.longitude]));
	const { results } = await db
		.prepare(
			`SELECT l.id, l.name, l.latitude, l.longitude FROM locations l
			 JOIN json_each(?) j
			   ON l.latitude = json_extract(j.value, '$[0]') AND l.longitude = json_extract(j.value, '$[1]')`
		)
		.bind(pairs)
		.all<{ id: string; name: string; latitude: number; longitude: number }>();
	const out = new Map<string, { id: string; name: string }>();
	for (const r of results) {
		const key = coordinateKey(r.latitude, r.longitude);
		if (!out.has(key)) out.set(key, { id: r.id, name: r.name });
	}
	return out;
}

/**
 * Every OPEN location whose point falls inside `bbox`, as the minimal shape the
 * proximity checks need (near-duplicate warnings on create, the duplicate audit).
 * Callers refine by exact distance/name — this is just the indexed box read.
 */
export async function openLocationsInBbox(
	db: D1Like,
	bbox: Bounds
): Promise<{ id: string; name: string; latitude: number; longitude: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, latitude, longitude FROM locations
			 WHERE closed_at IS NULL AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`
		)
		.bind(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng)
		.all<{ id: string; name: string; latitude: number; longitude: number }>();
	return results;
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
 * ranking) — so one downtown tile can't blow up the payload. Representative
 * levels cap at 1 by construction.
 */
export const FULL_CELL_CAP = 100;

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
	const perCellCap = level === 0 ? FULL_CELL_CAP : 1;
	const cover = cellsCoverBounds(cells, cellDeg);
	const keys = cells.map(([i, j]) => cellKey(i, j));
	const membership = search === null ? null : searchMembership(search);

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
					(SELECT COUNT(*) FROM liked_locations lk WHERE lk.location_id = l.id) AS likes,
					(CAST((l.latitude + 90) / ? AS INTEGER) || ':' || CAST((l.longitude + 180) / ? AS INTEGER)) AS ck
				FROM locations l
				WHERE l.closed_at IS NULL AND l.latitude BETWEEN ? AND ? AND l.longitude BETWEEN ? AND ?
					${membership === null ? '' : `AND (${membership.cond})`}
			),
			ranked AS (
				SELECT id, ck,
					ROW_NUMBER() OVER (
						PARTITION BY ck
						ORDER BY (menu_id IS NOT NULL) DESC, likes DESC, name, id
					) AS rn
				FROM boxed
				WHERE ck IN (SELECT value FROM json_each(?))
			)
			SELECT id, ck FROM ranked WHERE rn <= ? ORDER BY ck, rn`
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
		.all<{ id: string; ck: string }>();

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
	const data = await queryMapData(
		db,
		`id IN (SELECT value FROM json_each(?))`,
		[JSON.stringify(picked.map((row) => row.id))],
		`ORDER BY name, id LIMIT ${picked.length}`
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
	detail?: false
): Promise<MapData>;
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[],
	capClause: string = DEFAULT_MAP_CAP,
	detail: boolean = false
): Promise<MapData> {
	// The one evaluation of `locFilter`: the capped, `capClause`-ordered location
	// rows themselves. `closed_at IS NULL` hides soft-deleted (permanently-closed)
	// venues from every map/detail/search read this powers (migration 0015). It
	// carries no bind param, so the `.bind(...params)` alignment is untouched.
	// `score` is the like count as a correlated index probe per returned row
	// (bounded by the cap, same shape as getMapCellsData's ranking term) —
	// aliased to its opaque wire name here so no later step needs to rename it.
	const { results: locations } = await db
		.prepare(
			`SELECT ${LOCATION_FIELDS},
				(SELECT COUNT(*) FROM liked_locations lk WHERE lk.location_id = locations.id) AS score
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

	// The tuple cast mirrors each statement's projection 1:1 — `batch` itself is
	// typed `unknown[]` on D1Like because the two backends (Worker binding,
	// d1-http shim) type their per-statement results differently, though both
	// return `{ results }` objects in statement order. The menu-source read runs
	// only in detail mode (sources are surfaced in the ONE open venue's panel, not
	// on the lean map payload), appended after the fixed core statements so the
	// destructuring holds in both modes — its slot is simply absent on a lean read.
	const coreStatements = [
		db
			.prepare(
				`SELECT ${detail ? ITEM_FIELDS : MAP_ITEM_FIELDS} FROM items WHERE menu_id IN (${inMenus}) ORDER BY menu_id, item_name`
			)
			.bind(menuIds),
		db
			.prepare(`SELECT id, currency, last_verified FROM menus WHERE id IN (${inMenus})`)
			.bind(menuIds),
		db
			.prepare(
				`SELECT it.item_id AS owner_id, ${ITEM_TAG_SELECT}
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
		{ results: ItemRow[] },
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
	const tagsByItem = groupItemTags(itemTagRows);
	const sourcesByMenu = groupSources(menuSourceRes?.results ?? []);
	const currencyByMenu = new Map(menuCurrencyRows.map((r) => [r.id, r.currency]));
	const menuMeta: MapData['menuMeta'] = {};
	for (const row of menuCurrencyRows) {
		menuMeta[row.id] = {
			last_verified: row.last_verified,
			sources: sourcesByMenu.get(row.id) ?? []
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
		const full: Item | null = detail
			? {
					...lean,
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

	const mapLocations: MapLocation[] = locations.map((loc) => ({
		...loc,
		address: formatAddress(loc),
		overrides: overridesByLocation.get(loc.id) ?? []
	}));

	return { locations: mapLocations, menus, menuMeta };
}

/**
 * Whether an OPEN location with this id exists. The existence probe behind the
 * map page's `/locations/<id>` 404 gate (src/routes/+page.server.ts): it runs
 * on every hard load of a venue URL, so it deliberately reads one column of one
 * row rather than paying {@link getLocationById}'s full row read whose result
 * the gate would throw away. Closed (soft-deleted) venues
 * count as absent, matching every display read (migration 0015) — their pages
 * should 404, not render.
 */
export async function locationExists(db: D1Like, id: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS one FROM locations WHERE id = ? AND closed_at IS NULL`)
		.bind(id)
		.first<{ one: number }>();
	return row !== null;
}

export async function getLocationById(db: D1Like, id: string): Promise<Location | null> {
	const row = await db
		// Closed (soft-deleted) venues are hidden from get_location too (migration 0015);
		// they remain in D1 for analysis and are reopenable via setLocationClosed.
		.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE id = ? AND closed_at IS NULL`)
		.bind(id)
		.first<LocationRow>();
	if (!row) return null;
	return { ...row, address: formatAddress(row) };
}

/**
 * The lean projection behind `/sitemap.xml`: every open venue's id plus its
 * menu's `last_verified` date, the honest `<lastmod>` signal — the menu IS the
 * page's substance, so the date it was last checked against its source is when
 * the page last meaningfully changed (NULL for a venue without a menu yet).
 * Closed (soft-deleted) venues are excluded: their pages are hidden from the
 * map (migration 0015), so listing them would only hand crawlers soft-404s.
 * LIMIT 250000 is a Worker-memory bound, not a protocol one: the sitemap
 * index (src/routes/sitemap.xml) pages past the protocol's 50k-per-file cap,
 * but sitemap-cache.ts holds the whole result as one in-memory array — at
 * ~150 B per entry that's tens of MB at this cap. Growing past it means
 * per-page keyset-paginated reads instead of one cached full read.
 */
export async function getSitemapEntries(
	db: D1Like
): Promise<{ id: string; last_verified: string | null }[]> {
	const { results } = await db
		.prepare(
			`SELECT l.id AS id, m.last_verified AS last_verified
			 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
			 WHERE l.closed_at IS NULL
			 ORDER BY l.id
			 LIMIT 250000`
		)
		.all<{ id: string; last_verified: string | null }>();
	return results;
}

/** Returns all items of a menu, each with its tags. Provenance is menu-level (see {@link getMenuById}). */
async function getItemsByMenu(db: D1Like, menuId: string): Promise<Item[]> {
	const [{ results: rows }, menuRow, { results: tagRows }] = await Promise.all([
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
			.all<ItemTagRow>()
	]);

	const tagsByItem = groupItemTags(tagRows);
	const currency = menuRow?.currency ?? DEFAULT_CURRENCY;
	return rows.map((row) => ({
		...row,
		currency,
		tags: tagsByItem.get(row.id) ?? []
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

/** Returns a single item with its tags, or `null`. Provenance is menu-level (see {@link getMenuById}). */
export async function getItemById(db: D1Like, id: string): Promise<Item | null> {
	const [row, { results: tags }] = await Promise.all([
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
			.all<ItemTagRow>()
	]);
	if (!row) return null;
	const menuRow = await db
		.prepare(`SELECT currency FROM menus WHERE id = ?`)
		.bind(row.menu_id)
		.first<{ currency: string }>();
	return {
		...row,
		currency: menuRow?.currency ?? DEFAULT_CURRENCY,
		tags: tags.map((t) => ({
			id: t.id,
			name: t.name,
			tag_type: t.tag_type,
			optional: t.optional !== 0
		}))
	};
}

// ---------------------------------------------------------------------------
// Writes — shared item-write helpers
// ---------------------------------------------------------------------------

/** Tag content for one item write (insert or update). Provenance is menu-level, not per item. */
interface ItemContent {
	tags?: TagId[];
	optionalTags?: TagId[];
}

/** A single `item_tags` link statement. */
function linkTagStmt(db: D1Like, itemId: string, tagId: string, optional: 0 | 1): D1PreparedLike {
	return db
		.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional) VALUES (?, ?, ?)`)
		.bind(itemId, tagId, optional);
}

/**
 * Statements that link an item to its curated dietary/course tags, from `tags`
 * (required) and `optionalTags` (the per-edge `optional` flag — e.g. a dish that
 * can be made vegan on request). Tags an asserted stronger diet entails are
 * silently dropped (DIET_TAG_IMPLIES: an asserted vegan strips vegetarian /
 * dairy_free from BOTH sets — a vegan dish "can be made vegetarian" says
 * nothing); the diet filter matches vegan items under the entailed diets via
 * the same closure, so nothing is lost. An optional vegan strips nothing.
 */
function tagLinkStmts(db: D1Like, itemId: string, content: ItemContent): D1PreparedLike[] {
	const implied = impliedDietTagIds((content.tags ?? []).map((id) => ({ id, optional: false })));
	const stmts: D1PreparedLike[] = [];
	for (const tagId of content.tags ?? [])
		if (!implied.has(tagId)) stmts.push(linkTagStmt(db, itemId, tagId, 0));
	for (const tagId of content.optionalTags ?? [])
		if (!implied.has(tagId)) stmts.push(linkTagStmt(db, itemId, tagId, 1));
	return stmts;
}

/** Shape of one item to insert into a given menu. */
export interface ItemInsertSpec extends ItemContent {
	id?: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
}

/**
 * Display text is cleaned of HTML character references on EVERY write (`&amp;` →
 * `&`): menu research scrapes web sources, so encoded entities occasionally leak
 * into item/location/menu/brand names. Decoding at the db funnels covers every
 * ingestion path (MCP tools, chain imports, inline `menu_items`) at once. The
 * html_entities audit should therefore always come back clean.
 */
const cleanText = decodeHtmlEntities;
const cleanTextOrNull = (value: string | null | undefined): string | null =>
	value === null || value === undefined ? null : decodeHtmlEntities(value);

/** Builds the full statement list to insert one item (row + tags). */
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
			.bind(
				id,
				menuId,
				cleanText(spec.item_name),
				cleanTextOrNull(spec.description),
				spec.price ?? null
			),
		...tagLinkStmts(db, id, spec)
	];
}

// ---------------------------------------------------------------------------
// Writes — locations
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertLocations} (one per location). */
export type LocationInsert = Omit<Location, 'id' | 'brand_id' | 'menu_id' | 'address'> & {
	id?: string;
	brand_id?: string | null;
	menu_id?: string | null;
	/**
	 * Provenance for the PRIVATE menu created when `items` are given (sources are
	 * menu-level). Ignored for a chain branch (which shares its menu) or a location
	 * with no inline items (which gets no menu here).
	 */
	menuSources?: Source[];
	/**
	 * Unix-ms timestamp marking this venue PERMANENTLY CLOSED at import time (a
	 * "born-closed" tombstone), or null/undefined for a normal live venue. A closed
	 * row is hidden from every display/browse read but still blocks re-creation and
	 * search_poi re-suggestion. Paired with {@link closed_reason}. Not combined with
	 * `items` — a closed venue has no menu. To close a venue already on the map (and
	 * keep its likes) use {@link setLocationClosed}, not a re-insert.
	 */
	closed_at?: number | null;
	/** Short note with the closure evidence; null/undefined when open. */
	closed_reason?: string | null;
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
 * Inserts many locations (and optionally each venue's own menu items, with the
 * menu's sources) in one atomic batch and returns their ids in input order: either
 * every location is written or, on any error, none are. Pass a single location to
 * add just one. Ideal for backfilling a chain's branches — give each the same
 * `brand_id`/`menu_id` so they all serve the shared menu — or for adding an
 * independent venue and its menu at once via `items`. One call is one db.batch
 * (a single D1 HTTP request), so callers with unbounded input should split it
 * with {@link chunkLocationInserts} first — atomicity then holds per chunk.
 */
export async function insertLocations(db: D1Like, locs: LocationInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const loc of locs) {
		const id = loc.id ?? crypto.randomUUID();
		ids.push(id);
		const name = cleanText(loc.name);
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
						`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, ?)`
					)
					// last_verified is required (migration 0012); a new private menu is
					// verified as of its creation date.
					.bind(privateMenuId, name, loc.currency ?? DEFAULT_CURRENCY, currentVerificationDate())
			);
			// Provenance lives on the menu now: attach the venue's sources to its private menu.
			for (const source of loc.menuSources ?? []) {
				stmts.push(
					db
						.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
						.bind(privateMenuId, source.url, source.label ?? null)
				);
			}
		}
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, brand_id, menu_id, closed_at, closed_reason)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					name,
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
					loc.menu_id ?? privateMenuId,
					loc.closed_at ?? null,
					loc.closed_reason ?? null
				)
		);
		if (privateMenuId) {
			for (const item of loc.items ?? []) {
				stmts.push(...insertItemStmts(db, item.id ?? crypto.randomUUID(), privateMenuId, item));
			}
		}
	}
	await db.batch(stmts);
	return ids;
}

/**
 * How many statements {@link insertLocations} builds for one location: the
 * private-menu row and its menu-source links (only when it has inline `items`),
 * the location row, and per item its row plus one per tag/optional-tag link —
 * counting only the links tagLinkStmts actually emits (entailed-redundant tags
 * are stripped, see DIET_TAG_IMPLIES). Kept next to insertLocations so the
 * count and the statement builder stay in sync (see the parity test in
 * create-locations.test.ts).
 */
export function locationInsertStatementCount(loc: LocationInsert): number {
	const items = loc.items ?? [];
	const hasItems = items.length > 0;
	return (
		(hasItems ? 1 : 0) +
		(hasItems ? (loc.menuSources?.length ?? 0) : 0) +
		1 +
		items.reduce((n, item) => {
			const implied = impliedDietTagIds((item.tags ?? []).map((id) => ({ id, optional: false })));
			const links = [...(item.tags ?? []), ...(item.optionalTags ?? [])].filter(
				(id) => !implied.has(id)
			).length;
			return n + 1 + links;
		}, 0)
	);
}

/**
 * Splits a {@link insertLocations} batch at LOCATION boundaries into chunks of
 * at most `maxStatements` statements each (per {@link locationInsertStatementCount}),
 * so no single db.batch call inlines an unbounded statement list into one D1
 * HTTP request. A location's own statements are never split — its private menu
 * and items must land in the same atomic batch — so one location over the cap
 * by itself gets a chunk of its own. Order is preserved; concatenating the
 * chunks reproduces the input.
 */
export function chunkLocationInserts<T extends LocationInsert>(
	locs: T[],
	maxStatements: number
): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let count = 0;
	for (const loc of locs) {
		const n = locationInsertStatementCount(loc);
		if (current.length && count + n > maxStatements) {
			chunks.push(current);
			current = [];
			count = 0;
		}
		current.push(loc);
		count += n;
	}
	if (current.length) chunks.push(current);
	return chunks;
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
};

/**
 * Statements that apply one location patch: the scalar SET (only the columns
 * present in `patch`). No existence check — {@link updateLocations} resolves which
 * ids exist up front so the whole batch stays a single round trip. Provenance is
 * menu-level, so a location patch never touches sources (use update_menu).
 */
function locationUpdateStmts(db: D1Like, patch: LocationPatch): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];
	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of LOCATION_COLUMNS) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : value);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db
				.prepare(`UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`)
				.bind(...values, patch.id)
		);
	}
	return stmts;
}

/**
 * Applies many partial location updates in one atomic batch. Each patch touches
 * only the fields it carries. Ids that don't exist are skipped and reported in
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
	// Single json_each bind: update_locations batches up to 100 patches, at the edge of
	// D1's ~100 per-query bound-parameter limit as an `IN (?, …)` list.
	const { results } = await db
		.prepare(`SELECT id FROM locations WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
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

/**
 * Soft-deletes (or reopens) an existing location by flipping its `closed_at`/
 * `closed_reason`, WITHOUT touching the row's likes or menu — the reason a
 * permanently-closed venue is marked rather than {@link deleteLocation}'d (a delete
 * would cascade `liked_locations` away; see migration 0015). Pass `closedAt = null`
 * (and `reason = null`) to reopen. The closure evidence is captured in `reason`
 * (provenance is menu-level now, so there is no per-location source to append).
 * Returns false when no location has that id. For a venue NOT yet on the map, use
 * {@link insertLocations} with `closed_at` set instead (a born-closed tombstone).
 */
export async function setLocationClosed(
	db: D1Like,
	id: string,
	closedAt: number | null,
	reason: string | null
): Promise<boolean> {
	const exists = await db.prepare(`SELECT id FROM locations WHERE id = ?`).bind(id).first();
	if (!exists) return false;
	await db
		.prepare(`UPDATE locations SET closed_at = ?, closed_reason = ? WHERE id = ?`)
		.bind(closedAt, reason, id)
		.run();
	return true;
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
				.first<{
					id: string;
					name: string;
					menu_id: string | null;
					brand_id: string | null;
				}>()
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
					`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, ?)`
				)
				// last_verified is required (migration 0012); default a new menu to today.
				.bind(menuId, owner.name, currency, currentVerificationDate()),
			db.prepare(`UPDATE locations SET menu_id = ? WHERE id = ?`).bind(menuId, locationId)
		);
	});
	return { menuByLocation, stmts };
}

/**
 * Inserts many items belonging to independent venues (their own private menus),
 * in one atomic batch, returning their ids in input order. A venue with no menu yet
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
	// Adding items refreshes each venue's private menu (a brand-new one is created
	// with today already; an existing one is re-stamped here).
	stmts.push(...touchMenuStmts(db, menuByLocation.values()));
	await db.batch(stmts);
	return ids;
}

/**
 * Statements that apply one item patch: the scalar SET (only the columns present
 * in `patch`), plus per-set replacement for the dietary/course tags. Each tag set
 * provided replaces only its own scope — `tags` the required links
 * (`item_tags.optional = 0`), `optionalTags` the optional links (`optional = 1`)
 * — so patching one set never silently wipes the other (dietary tags are
 * source-asserted; `tags: []` clears just the required set). Providing both is a
 * full replace, as before. No existence check — the caller ({@link updateItems})
 * resolves which ids exist up front so a whole batch stays a single round trip.
 * Provenance is menu-level, so an item patch never touches sources.
 */
function itemUpdateStmts(db: D1Like, id: string, patch: ItemUpdate): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of ['menu_id', 'item_name', 'description', 'price'] as const) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(
				(col === 'item_name' || col === 'description') && typeof value === 'string'
					? cleanText(value)
					: value
			);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE items SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}

	// Replace the dietary/course tag set(s), scoped to the set(s) actually
	// provided: clear only the patched scope's links (required and/or optional),
	// then re-link the new set (which tagLinkStmts strips of entailed-redundant
	// tags). A tag id named in the patch is also cleared from the OTHER scope —
	// item_tags is keyed (item_id, tag_id), so without that a pre-existing link at
	// the other optionality would make the re-link an INSERT OR IGNORE no-op and
	// the patch's explicit required/optional assertion would be lost.
	if (patch.tags !== undefined || patch.optionalTags !== undefined) {
		const scopes: string[] = [];
		if (patch.tags !== undefined) scopes.push('0');
		if (patch.optionalTags !== undefined) scopes.push('1');
		const patchedTagIds = [...(patch.tags ?? []), ...(patch.optionalTags ?? [])];
		const crossScopeClause =
			patchedTagIds.length > 0 ? ` OR tag_id IN (${patchedTagIds.map(() => '?').join(', ')})` : '';
		stmts.push(
			db
				.prepare(
					`DELETE FROM item_tags WHERE item_id = ?
					 AND (optional IN (${scopes.join(', ')})${crossScopeClause})
					 AND tag_id IN (SELECT id FROM tags WHERE tag_type IN ('dietary', 'course'))`
				)
				.bind(id, ...patchedTagIds)
		);
		stmts.push(...tagLinkStmts(db, id, patch));
	}

	return stmts;
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

/** Aggregate coverage totals for the public landing overlay (see {@link getStats}). */
export interface MapStats {
	/** Total food locations on the map. */
	locations: number;
	/** Total menu items captured (a shared chain menu's items counted once). */
	items: number;
	/** Distinct cities covered, keyed by city + region + country so same-named
	 *  cities in different provinces/countries aren't merged. */
	cities: number;
}

/**
 * Coverage totals shown on the zoomed-out landing overlay: how much data we've
 * collected. One round-trip via correlated scalar subqueries. Safe to expose
 * without auth — it returns only counts, never any row data.
 */
export async function getStats(db: D1Like): Promise<MapStats> {
	const row = await db
		.prepare(
			// Closed (soft-deleted) venues are excluded so coverage totals reflect the live map
			// (migration 0015). Item count is menu-level and left as-is.
			`SELECT
				(SELECT COUNT(*) FROM locations WHERE closed_at IS NULL) AS locations,
				(SELECT COUNT(*) FROM items) AS items,
				(SELECT COUNT(DISTINCT city || '|' || region || '|' || country) FROM locations WHERE closed_at IS NULL) AS cities`
		)
		.first<MapStats>();
	return row ?? { locations: 0, items: 0, cities: 0 };
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
		.bind(id, cleanText(brand.name), brand.website ?? null, brand.logo_url ?? null)
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
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : (value ?? null));
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
 * Deletes a brand and (by cascade) its menus, their items, tag links and menu sources.
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

const MENU_FIELDS = `id, brand_id, name, region, currency, last_verified, refresh_notes`;

/**
 * Lists brand menus (with an item count), optionally filtered by brand. Private
 * venue menus (brand_id NULL) are an implementation detail and excluded.
 */
export async function getMenus(db: D1Like, brandId?: string): Promise<MenuSummary[]> {
	// location_count = OPEN branches serving the menu, so an audit can see each
	// menu's live footprint without paging list_locations (closed branches keep
	// their menu_id but are off the map — counting them would overstate coverage).
	// Correlated subqueries, not LEFT JOINs: two independent joins would fan out
	// to item_count × location_count rows per menu before GROUP BY collapses them
	// (~1M+ rows_read for a large chain menu); each subquery is a linear index scan.
	const sql =
		`SELECT m.id, m.brand_id, m.name, m.region, m.currency, m.last_verified,
			(SELECT COUNT(*) FROM items i WHERE i.menu_id = m.id) AS item_count,
			(SELECT COUNT(*) FROM locations l WHERE l.menu_id = m.id AND l.closed_at IS NULL)
				AS location_count
		 FROM menus m` +
		(brandId ? ` WHERE m.brand_id = ?` : ` WHERE m.brand_id IS NOT NULL`) +
		` ORDER BY m.name`;
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

/** Number of items on a menu (0 for a missing menu). */
export async function countMenuItems(db: D1Like, menuId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM items WHERE menu_id = ?`)
		.bind(menuId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Validates a brand/menu pair before linking a location (or a whole chain import)
 * to it. `null`/`undefined` ids are skipped (detaching is always allowed), but a
 * non-null `menuId` is only accepted as a SHARED brand menu with its owning brand
 * passed alongside: a private venue menu (brand_id NULL) is an implementation
 * detail that must never be shared — attaching one would make every linked
 * location display (and edit) that venue's items — and requiring
 * `menu.brand_id === brandId` stops a location from silently joining another
 * brand's menu.
 */
export async function assertBrandMenuRefs(
	db: D1Like,
	brandId: string | null | undefined,
	menuId: string | null | undefined
): Promise<void> {
	if (brandId) {
		if (!(await getBrandById(db, brandId))) throw new Error(`No brand with id "${brandId}".`);
	}
	if (menuId) {
		const menu = await getMenuById(db, menuId);
		if (!menu) throw new Error(`No menu with id "${menuId}".`);
		if (menu.brand_id === null) {
			throw new Error(
				`Menu "${menuId}" is an independent venue's private menu — it cannot be attached to ` +
					`another location or used as a chain menu. Create a shared menu with create_menu ` +
					`(after create_brand) instead.`
			);
		}
		if (!brandId) {
			throw new Error(
				`Menu "${menuId}" is brand "${menu.brand_id}"'s shared menu — pass that brand_id ` +
					`together with menu_id so the branch is linked to its chain.`
			);
		}
		if (menu.brand_id !== brandId) {
			throw new Error(
				`Menu "${menuId}" belongs to brand "${menu.brand_id}", not "${brandId}". ` +
					`Pass the menu's own brand_id.`
			);
		}
	}
}

export async function getMenuWithItems(db: D1Like, id: string): Promise<MenuWithItems | null> {
	const menu = await getMenuById(db, id);
	if (!menu) return null;
	return { ...menu, items: await getItemsByMenu(db, id) };
}

export async function insertMenu(
	db: D1Like,
	menu: Omit<Menu, 'id' | 'sources' | 'currency' | 'last_verified' | 'refresh_notes'> & {
		id?: string;
		currency?: string;
		refresh_notes?: string | null;
		sources?: Source[];
	}
): Promise<string> {
	const id = menu.id ?? crypto.randomUUID();
	const stmts: D1PreparedLike[] = [
		db
			.prepare(
				`INSERT INTO menus (id, brand_id, name, region, currency, last_verified, refresh_notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				menu.brand_id ?? null,
				cleanText(menu.name),
				menu.region ?? null,
				menu.currency ?? DEFAULT_CURRENCY,
				// last_verified is always "now": a just-created menu is verified as of its
				// creation, the date is never an agent-supplied parameter, and a real date
				// satisfies migration 0012's non-empty requirement.
				currentVerificationDate(),
				menu.refresh_notes ?? null
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

// `last_verified` is excluded: it is never set from the patch, but always stamped
// to today on any update (the menu's data was just re-checked against its source).
const MENU_COLUMNS = ['brand_id', 'name', 'region', 'currency', 'refresh_notes'] as const;

/**
 * Partial update of a menu. Scalar fields present in `patch` are written; if
 * `patch.sources` is given it replaces the whole source set (pass `[]` to clear).
 * Any update also refreshes `last_verified` to today (it is auto-managed, not a
 * patch field). Returns the updated menu, or `null` if no menu has that id.
 */
export async function updateMenu(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Menu, 'id' | 'last_verified'>> & {
		/** Append these sources (dedupe by url), keeping existing ones — vs `sources` which replaces. */
		addSources?: Source[];
	}
): Promise<Menu | null> {
	if (!(await getMenuById(db, id))) return null;

	const stmts: D1PreparedLike[] = [];
	// Always re-stamp last_verified, so even a sources-only edit marks the menu fresh.
	const assignments: string[] = ['last_verified = ?'];
	const values: (string | null)[] = [currentVerificationDate()];
	for (const col of MENU_COLUMNS) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : (value ?? null));
		}
	}
	stmts.push(
		db.prepare(`UPDATE menus SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
	);
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
 * Deletes a menu and (by cascade) its items, their tag links and the menu's sources. Any
 * locations serving it revert to having no menu (`menu_id` set NULL). Returns
 * `true` if a row was removed.
 */
export async function deleteMenu(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM menus WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Duplicate-audit verdicts (location_pair_reviews, migration 0018): a durable
// "these two locations are DISTINCT venues" record, so the duplicate audit
// stops re-flagging a pair someone already verified against the venue's own
// locator. Confirmed duplicates need no verdict — deleting the extra row
// resolves them (and cascades away any verdict either half carried).
// ---------------------------------------------------------------------------

/** Canonical ordered form of an unordered location pair (a < b). */
export function orderedPair(idA: string, idB: string): [string, string] {
	return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * Records that two locations were verified as two REAL venues — not one venue
 * double-mapped — with the evidence in `reason`. Idempotent: re-marking the
 * pair replaces the reason and re-stamps the review date. Returns whether a
 * verdict already existed.
 */
export async function markLocationsDistinct(
	db: D1Like,
	idA: string,
	idB: string,
	reason: string
): Promise<{ already_reviewed: boolean }> {
	const [a, b] = orderedPair(idA, idB);
	const existing = await db
		.prepare(
			`SELECT 1 AS x FROM location_pair_reviews WHERE location_id_a = ? AND location_id_b = ?`
		)
		.bind(a, b)
		.first<{ x: number }>();
	await db
		.prepare(
			`INSERT OR REPLACE INTO location_pair_reviews
				(location_id_a, location_id_b, verdict, reason, reviewed_at)
			 VALUES (?, ?, 'distinct', ?, ?)`
		)
		.bind(a, b, reason, currentVerificationDate())
		.run();
	return { already_reviewed: Boolean(existing) };
}

/** Revokes a distinct-pair verdict (the pair audits normally again). True when a row was deleted. */
export async function unmarkLocationsDistinct(
	db: D1Like,
	idA: string,
	idB: string
): Promise<boolean> {
	const [a, b] = orderedPair(idA, idB);
	const res = await db
		.prepare(`DELETE FROM location_pair_reviews WHERE location_id_a = ? AND location_id_b = ?`)
		.bind(a, b)
		.run();
	return res.meta.changes > 0;
}

/** Every reviewed-distinct pair as an ordered "a|b" key set (audit suppression). */
export async function reviewedPairKeys(db: D1Like): Promise<Set<string>> {
	const { results } = await db
		.prepare(`SELECT location_id_a, location_id_b FROM location_pair_reviews`)
		.all<{ location_id_a: string; location_id_b: string }>();
	return new Set(results.map((r) => `${r.location_id_a}|${r.location_id_b}`));
}

// ---------------------------------------------------------------------------
// Shared menu items (belong to a menu — cf. the create_items location_id path, which adds
// to a venue's own private menu). Both write to the same `items` table. Reading,
// updating and deleting items are id-keyed and menu-agnostic, so they use the
// generic getItemById / updateItems / deleteItem rather than a per-kind variant.
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
	// Adding items is data flowing into each target menu — mark them freshly verified.
	stmts.push(
		...touchMenuStmts(
			db,
			items.map((it) => it.menu_id)
		)
	);
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
	// Single json_each bind (an exhaustive create_items menu can carry hundreds of
	// names, past D1's ~100 per-query bound-parameter limit). SQLite's IN uses the
	// LEFT operand's collating sequence, so COLLATE NOCASE on item_name keeps the
	// subselect match case-insensitive.
	const { results } = await db
		.prepare(
			`SELECT id, item_name FROM items WHERE menu_id = ? AND item_name COLLATE NOCASE IN (SELECT value FROM json_each(?))`
		)
		.bind(menuId, JSON.stringify(distinct))
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

/** The fields of one item patch (see {@link ItemPatch} / {@link updateItems}). */
export type ItemUpdate = {
	/** Move the item to a different menu (rare). */
	menu_id?: string;
	item_name?: string;
	description?: string | null;
	price?: number | null;
} & ItemContent;

/** A partial update to one item, keyed by id (for {@link updateItems}). */
export type ItemPatch = ItemUpdate & { id: string };

/**
 * Applies one or more partial item updates in one atomic batch, mirroring
 * {@link updateLocations}. For a shared chain item the change applies to EVERY
 * branch serving its menu; for a venue's own item it applies to that venue. Each
 * patch touches only the fields it carries (replace-set semantics; see
 * {@link itemUpdateStmts}). Ids that don't exist are skipped and reported in
 * `notFoundIds` rather than aborting the batch. Returns which ids were updated and
 * which were not found — one round trip instead of a call per item, for menu-wide
 * corrections.
 */
export async function updateItems(
	db: D1Like,
	patches: ItemPatch[]
): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
	if (patches.length === 0) return { updatedIds: [], notFoundIds: [] };
	const ids = patches.map((p) => p.id);
	// Single json_each bind: update_items batches up to 200 patches, double D1's ~100
	// per-query bound-parameter limit as an `IN (?, …)` list.
	const { results } = await db
		.prepare(`SELECT id, menu_id FROM items WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
		.all<{ id: string; menu_id: string }>();
	const menuByItem = new Map(results.map((r) => [r.id, r.menu_id]));

	const updatedIds: string[] = [];
	const notFoundIds: string[] = [];
	const affectedMenus = new Set<string>();
	const stmts: D1PreparedLike[] = [];
	for (const { id, ...patch } of patches) {
		const currentMenu = menuByItem.get(id);
		if (currentMenu === undefined) {
			notFoundIds.push(id);
			continue;
		}
		updatedIds.push(id);
		// The item's current menu is refreshed; a move (patch.menu_id) also touches
		// the destination menu, which just gained the item.
		affectedMenus.add(currentMenu);
		if (patch.menu_id) affectedMenus.add(patch.menu_id);
		stmts.push(...itemUpdateStmts(db, id, patch));
	}
	if (stmts.length > 0) {
		stmts.push(...touchMenuStmts(db, affectedMenus));
		await db.batch(stmts);
	}
	return { updatedIds, notFoundIds };
}

/** Deletes an item and its tag links (and any per-location overrides). Returns `true` if removed. */
export async function deleteItem(db: D1Like, id: string): Promise<boolean> {
	// Resolve the parent menu before the delete so we can mark it freshly verified
	// (removing an item is a reconciliation against the source like any other write).
	const row = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(id)
		.first<{ menu_id: string }>();
	if (!row) return false;
	await db.batch([
		db.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
		...touchMenuStmts(db, [row.menu_id])
	]);
	return true;
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
 * currently-stored value (so toggling just `available` never wipes a previously
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
	// Resolve the item's menu so the override (a per-branch delta against it) marks
	// that menu freshly verified, in the same atomic batch as the upsert.
	const menuRow = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(itemId)
		.first<{ menu_id: string }>();
	await db.batch([
		db
			.prepare(
				`INSERT INTO location_item_overrides (location_id, item_id, available, price)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(location_id, item_id)
				 DO UPDATE SET available = excluded.available, price = excluded.price`
			)
			.bind(locationId, itemId, available, price),
		...touchMenuStmts(db, menuRow ? [menuRow.menu_id] : [])
	]);
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
	if (res.meta.changes === 0) return false;
	// Clearing a per-branch delta re-asserts the menu default for it — mark the menu
	// freshly verified, matching the create/update override paths.
	const menuRow = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(itemId)
		.first<{ menu_id: string }>();
	if (menuRow) await db.batch(touchMenuStmts(db, [menuRow.menu_id]));
	return true;
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
