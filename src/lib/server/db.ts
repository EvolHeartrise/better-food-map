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

// Type-only import (erased at build time, so it adds no runtime dependency and
// keeps this module runtime-agnostic). `category.ts` is the canonical, client-safe
// home of the category union; re-exported below as part of this module's contract.
import type { Category } from '../category';
// Value import (tiny, pure, client-safe): the canonical display-address formatter,
// so the single-line `address` is composed identically wherever a location is read.
import { formatAddress } from '../address';

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
// single source of truth.
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
 */
export type TagType = 'dietary' | 'course';

export interface Tag {
	id: string;
	name: string;
	tag_type: TagType;
}

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
	 */
	menu_id: string | null;
	/** Citations for where this location's data came from (may be empty). */
	sources: Source[];
}

/**
 * A menu item. Belongs to a {@link Menu} — private to one venue, or shared
 * across a chain's branches.
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
	/** Tags applied to this item (dietary and course), with `optional`. */
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
	/**
	 * Per-menu metadata for the referenced menus, keyed by menu_id — currently just
	 * `last_verified` (the ISO date a menu was last checked against its source). Sent
	 * once per menu alongside {@link menus} so the detail view can show a freshness
	 * signal without a second read. Every menu carries a date (enforced by the
	 * triggers in migration 0012), so this is non-null for any menu present here; it
	 * is typed nullable only because the read column is.
	 */
	menuMeta: Record<string, { last_verified: string | null }>;
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

/**
 * Today's date as an ISO `YYYY-MM-DD` string (UTC). Used as the default
 * {@link Menu.last_verified} when a menu is created without one — every menu must
 * carry a verification date (enforced by the triggers in migration 0012), and a
 * just-created menu is "verified as of now". The app supplies this rather than a
 * SQLite `DEFAULT (date('now'))`, matching the convention of keeping time out of
 * the schema (see migration 0007).
 */
export function currentVerificationDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Statements that stamp each given menu's `last_verified` to today. Every MCP write
 * that adds or changes a menu or its items runs this, so a menu's freshness date
 * always reflects the last time data flowed into it — agents never supply the date
 * by hand (it is no longer a tool parameter). Ids are de-duplicated, and the valid
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

// The canonical tag list (dietary first, then course) — the display/filter order
// on the frontend. These are app-defined, never created from the UI, and seeded
// into D1 by migrations/0001_init.sql (renamed to (name, tag_type) by 0004). This
// is the WHOLE tag vocabulary: there are no data-created tags.
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
 * markers drawn — to a sane size. For a wide viewport the survivors are spatially
 * downsampled to one importance-ranked representative per grid cell (see
 * {@link getMapData}); for a narrow one they are importance-ranked then capped.
 * Mirrored on the client only to label a capped result set; this module stays the
 * source of truth for the value.
 */
export const MAP_RESULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getAllTags(): Tag[] {
	return TAGS.map((tag) => ({ ...tag }));
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

/**
 * Escapes LIKE wildcards in user input (paired with `ESCAPE '\'`). When the
 * result equals the input, nothing needed escaping — the pattern then carries no
 * escape character, so the `ESCAPE` clause may be omitted without changing what
 * the LIKE matches (getSearchMapData relies on this to keep the FTS5 trigram
 * pushdown, which an ESCAPE clause would disable — see migration 0016).
 */
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
	// Closed (soft-deleted) venues are hidden from the list overview (migration 0015);
	// this literal carries no bind param, so `params` alignment is untouched.
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
			// items it has overridden to unavailable.
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

// --- Viewport grid downsampling -------------------------------------------
// When the map is zoomed out, a viewport can cover thousands of venues — far more
// than can be drawn legibly, and enough to keep the client's label force-sim from
// ever settling. Rather than ship an arbitrary (alphabetical) slice, a wide viewport
// is tiled into a grid and only the single highest-importance representative of each
// cell is returned, so the labels come back spread UNIFORMLY across the screen. The
// grid is sized to the viewport (screen-space density stays ~constant at any zoom)
// but snapped to an ABSOLUTE lattice, so panning at one zoom doesn't reshuffle which
// venue represents a cell — only zooming, which changes the cell size, does.

// Target number of grid cells across the viewport's longer span; the representative
// cap (GRID_REP_LIMIT) bounds the total, this sets how fine the lattice is.
const GRID_DIVISIONS = 12;
// Below this cell size (~440 m) the viewport is a neighbourhood: downsampling would
// start hiding genuinely distinct on-screen venues, and the box is small enough that
// the flat cap suffices — so the grid is skipped and every venue in the box returned.
const MIN_GRID_CELL_DEG = 0.004;
// Hard ceiling on representatives the wide-viewport grid path returns. Set equal to
// MAP_RESULT_LIMIT so the zoomed-out path never ships more than the zoomed-in one (and
// queryMapData's default cap, also MAP_RESULT_LIMIT, never re-trims the set). The ids reach
// queryMapData through a single `json_each(?)` bind, NOT an `id IN (?, …)` list, so this is
// no longer bounded by D1's ~100 per-query parameter limit (the old reason it was pinned at
// 96). Crucially this is NOT used as a top-N cut at runtime: `gridCellSize` coarsens the
// lattice until a viewport can't hold more than this many cells, so the trailing `LIMIT`
// never actually trims. That matters because a top-N cut over a pan-varying pool is NOT
// pan-stable — as the box slides, which cells fall under the cut changes, flickering labels
// in and out. Guaranteeing every occupied cell fits under the cap makes a venue's
// visibility depend only on its absolute cell, never on the framing (see gridCellSize).
const GRID_REP_LIMIT = MAP_RESULT_LIMIT;

// Snap a raw degree span to a 1–2–5×10ⁿ ladder, so a small zoom change steps the
// lattice discretely rather than continuously resizing it (and reshuffling reps).
function niceStep(raw: number): number {
	const pow = 10 ** Math.floor(Math.log10(raw));
	const f = raw / pow;
	const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
	return m * pow;
}

// The next rung UP the 1–2–5×10ⁿ ladder from a {1,2,5,10}×10ⁿ `cell` (1→2→5→10…). Used by
// gridCellSize to coarsen the lattice a discrete step at a time. The +1e-9 nudges log10 off
// exact powers of ten (e.g. log10(0.1) landing at −1.0000000001) so the floor doesn't slip a
// decade and stall the coarsening loop.
function niceStepUp(cell: number): number {
	const pow = 10 ** Math.floor(Math.log10(cell) + 1e-9);
	const f = cell / pow;
	if (f < 1.5) return 2 * pow;
	if (f < 3.5) return 5 * pow;
	return 10 * pow;
}

// The grid cell size (degrees) for a viewport, or null when the box is small enough to skip
// downsampling and return everything in it (see MIN_GRID_CELL_DEG).
//
// The base size targets ~GRID_DIVISIONS cells across the longer span, but is then coarsened
// up the ladder until the viewport's WORST-CASE cell count can't exceed GRID_REP_LIMIT. That
// is what keeps the wide path pan-stable: gridRepresentativeIds' trailing `LIMIT` only causes
// flicker when it actually trims (a top-N over the in-view cells shuffles as you pan), so we
// size the lattice so it never has to. The bound `(⌈latSpan/cell⌉+1)·(⌈lngSpan/cell⌉+1)` is
// the most absolute-lattice cells a box of this span can straddle — the +1 per axis is the
// box-vs-lattice misalignment, and it must be there (omitting it under-counts and the cap
// still bites). Because the bound depends only on the span (not the pan position), the chosen
// cell is itself pan-stable. The loop converges fast (each rung ≥2× the cell, ≥4× fewer
// cells) and the `next > cell` guard is a float-safety backstop against ever spinning.
function gridCellSize(bounds: Bounds): number | null {
	const latSpan = bounds.maxLat - bounds.minLat;
	const lngSpan = bounds.maxLng - bounds.minLng;
	const span = Math.max(latSpan, lngSpan);
	if (!(span > 0)) return null;
	let cell = niceStep(span / GRID_DIVISIONS);
	// Decide narrow-vs-grid on the BASE cell, so the boundary is the documented ~440 m cell (a
	// neighbourhood returns everything). Coarsening below only ever grows the cell, so once we
	// commit to the grid path it always stays at or above MIN_GRID_CELL_DEG.
	if (cell < MIN_GRID_CELL_DEG) return null;
	while ((Math.ceil(latSpan / cell) + 1) * (Math.ceil(lngSpan / cell) + 1) > GRID_REP_LIMIT) {
		const next = niceStepUp(cell);
		if (!(next > cell)) break;
		cell = next;
	}
	return cell;
}

// The ids of the per-cell representative locations within `bounds`: partition the
// in-box venues onto the absolute lattice of `cell`-degree squares and, in each
// occupied cell, keep the most "important" one — a venue WITH a menu outranks one
// without, then more-liked outranks less, then name/id for determinism. Coordinates
// are shifted to be non-negative before the integer divide so the lattice floors
// consistently across the equator/prime-meridian (CAST truncates toward zero). At
// most GRID_REP_LIMIT cells (the most important) are returned.
async function gridRepresentativeIds(db: D1Like, bounds: Bounds, cell: number): Promise<string[]> {
	const { results } = await db
		.prepare(
			`WITH likes AS (
				SELECT location_id, COUNT(*) AS n FROM liked_locations GROUP BY location_id
			),
			ranked AS (
				SELECT l.id AS id, (l.menu_id IS NOT NULL) AS has_menu, COALESCE(lk.n, 0) AS likes,
					ROW_NUMBER() OVER (
						PARTITION BY
							CAST((l.latitude + 90) / ? AS INTEGER),
							CAST((l.longitude + 180) / ? AS INTEGER)
						ORDER BY (l.menu_id IS NOT NULL) DESC, COALESCE(lk.n, 0) DESC, l.name, l.id
					) AS rn
				FROM locations l
				LEFT JOIN likes lk ON lk.location_id = l.id
				WHERE l.closed_at IS NULL AND l.latitude BETWEEN ? AND ? AND l.longitude BETWEEN ? AND ?
			)
			SELECT id FROM ranked WHERE rn = 1
			ORDER BY has_menu DESC, likes DESC, id
			LIMIT ?`
		)
		.bind(cell, cell, bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng, GRID_REP_LIMIT)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/**
 * Returns everything the map page needs for the given viewport in one payload
 * (see {@link MapData}): a set of locations inside `bounds` with their per-item
 * overrides, plus each menu those locations reference resolved ONCE (keyed by
 * menu_id, each item carrying its tags and merged sources). The client joins the
 * two — applying each location's overrides — to reconstruct the effective menu,
 * so a shared chain menu travels the wire a single time instead of once per branch.
 *
 * Scoping the read to the visible box keeps the payload bounded as the dataset grows
 * to whole countries. A WIDE viewport (zoomed out) is additionally downsampled to one
 * importance-ranked representative per grid cell — at most {@link GRID_REP_LIMIT},
 * spread uniformly across the screen — so the map neither ships thousands of rows it
 * can't draw nor hands the client's label sim an unsettleable crowd. A NARROW viewport
 * returns every venue in the box (importance-ranked, capped at {@link MAP_RESULT_LIMIT}).
 * Built in bulk to avoid an N+1 query per location.
 */
export async function getMapData(db: D1Like, bounds: Bounds): Promise<MapData> {
	const cell = gridCellSize(bounds);
	if (cell === null) {
		// Narrow viewport: every venue in the box, the ones we have data for first.
		return queryMapData(
			db,
			`latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
			[bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng],
			IMPORTANCE_MAP_CAP
		);
	}
	// Wide viewport: pick one representative per grid cell, then resolve those concrete
	// ids (their menus, overrides, sources) the normal way. The ids travel as a single
	// JSON-array bind expanded with `json_each` rather than an `id IN (?, …)` list, so the
	// representative count isn't capped by D1's ~100 per-query parameter limit — that cap
	// is what used to force the flicker-inducing top-96 trim (see GRID_REP_LIMIT).
	const ids = await gridRepresentativeIds(db, bounds, cell);
	if (ids.length === 0) return { locations: [], menus: {}, menuMeta: {} };
	return queryMapData(db, `id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
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
 * A global menu search, anchored to a point. Unlike {@link getMapData} — which is
 * bounded to a viewport — this searches the WHOLE table and returns the
 * {@link MAP_RESULT_LIMIT} matches NEAREST to (`lat`,`lng`), nearest first, so the
 * map can act as a result view rather than the query itself.
 *
 * The single `query` is one combined free-text term matched as an OR across two
 * dimensions — the venue NAME and its item names — so one box finds both a place
 * ("Chipotle") and a dish ("burrito"):
 *   • the venue's `name` contains `query`  (→ the whole menu is relevant), OR
 *   • the venue has an item whose name contains `query`.
 * The `dietTagId` selector is a SEPARATE filter that always narrows: when set, the
 * matching item must ALSO carry that one curated dietary tag (the SAME item must
 * satisfy both name and diet), and a name-only match is kept only if the venue has
 * a diet-carrying item. With no `query` and no `dietTagId` this returns nothing.
 *
 * This mirrors the client's `matchedItems`/`results` membership exactly so the two
 * agree (the client re-filters the result set while a search is in flight). Per-
 * location overrides are not applied here (the shared menu is what's searched); the
 * client re-filters the resolved menu, so an item made unavailable at one branch
 * simply drops from that card.
 *
 * Text matching resolves through the FTS5 trigram mirrors (locations_fts /
 * items_fts, migration 0016) using the SAME `LIKE '%q%'` patterns as before —
 * never MATCH — so membership stays substring-exact (including 1–2 character
 * queries, which just aren't index-accelerated) while the trigram index takes a
 * 3+-character query from a two-table crawl to an index lookup.
 */
export interface SearchMapQuery {
	/** Combined free-text: matched against the venue name OR its item names. */
	query: string;
	/** A single curated dietary tag id the item must carry, or `null` for no diet filter. */
	dietTagId: string | null;
	/** Anchor the "nearest" ranking is measured from (the map centre). */
	lat: number;
	lng: number;
}

export function getSearchMapData(db: D1Like, q: SearchMapQuery): Promise<MapData> {
	const text = q.query.trim();
	const hasText = text !== '';
	const hasDiet = q.dietTagId !== null;

	// With neither filter this would match every venue; the caller only searches when
	// one is set, but guard so an empty query can't scan the whole table.
	if (!hasText && !hasDiet) return Promise.resolve({ locations: [], menus: {}, menuMeta: {} });

	// Both text dimensions resolve through the FTS5 trigram mirrors (migration 0016):
	// the pattern is the exact `%q%` substring LIKE as ever, but evaluated against the
	// FTS table, where the trigram index can serve it. The `ESCAPE` clause is appended
	// ONLY when the query contains a `%`/`_`/`\` that must match literally: SQLite
	// forwards only two-argument LIKEs to a virtual table, so LIKE+ESCAPE would force
	// a full FTS scan (the lesson recorded on the old tags_fts, migration 0006) — and
	// when nothing was escaped the pattern carries no `\`, so the two forms match
	// identically. Wildcard-carrying queries are rare and stay correct, just unindexed.
	const escapedText = escapeLikePattern(text);
	const namePattern = hasText ? `%${escapedText}%` : '';
	const like = escapedText === text ? 'LIKE ?' : "LIKE ? ESCAPE '\\'";
	// The venue-name dimension, joined back to the outer row by id. `locations.id`
	// names the outer table explicitly (it is always the unaliased `locations`
	// wherever `locFilter` is spliced in — see queryMapData); a stale mirror row can
	// only ever un-match, never invent a venue.
	const nameMatch = `locations.id IN (SELECT f.id FROM locations_fts f WHERE f.name ${like})`;
	// A correlated test that one of a venue's items carries the selected diet tag. The
	// outer table is referenced as `locations.menu_id` (see above), since `items`
	// also has a `menu_id` column and a bare name would be ambiguous.
	const dietExists = `EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id AND it.tag_id = ?)`;

	// Membership is an OR of independent disjuncts, built so each disjunct's `?`
	// placeholders are pushed onto `params` in the exact left-to-right order they
	// appear in the SQL (queryMapData binds locFilter params from the front, then the
	// distance-anchor params from the end).
	const disjuncts: string[] = [];
	const params: (string | number)[] = [];

	// Name match with no diet active → the whole menu is relevant, so the venue is kept
	// even with an empty menu (no item is required).
	if (hasText && !hasDiet) {
		disjuncts.push(nameMatch);
		params.push(namePattern);
	}
	// Name match WITH a diet active → kept only if some item carries the diet tag
	// (diet always narrows), so a name-only match with no diet-matching item drops.
	if (hasText && hasDiet) {
		disjuncts.push(
			`(${nameMatch} AND EXISTS (SELECT 1 FROM items i WHERE i.menu_id = locations.menu_id AND ${dietExists}))`
		);
		params.push(namePattern, q.dietTagId as string);
	}
	// An item satisfying every active predicate: its name contains `query` (when set)
	// AND it carries the diet tag (when set). The SAME item `i` must satisfy both. The
	// text side resolves through items_fts (an uncorrelated subquery — SQLite
	// materializes it once per statement) and joins back to `items` by id, so menu
	// membership always comes from `items`, never the mirror.
	{
		const itemConds: string[] = [];
		if (hasText) {
			itemConds.push(`i.id IN (SELECT f.id FROM items_fts f WHERE f.item_name ${like})`);
			params.push(namePattern);
		}
		if (hasDiet) {
			itemConds.push(dietExists);
			params.push(q.dietTagId as string);
		}
		disjuncts.push(
			`EXISTS (SELECT 1 FROM items i WHERE i.menu_id = locations.menu_id AND ${itemConds.join(' AND ')})`
		);
	}

	// Rank by an approximate squared planar distance from the anchor: latitude in
	// degrees, longitude scaled by cos²(lat) so a degree of longitude counts for
	// its real (shrunk) width at this latitude. Exact enough to order matches
	// within a region; the anchor params bind AFTER the disjunct params (see queryMapData).
	const lngScale = Math.cos((q.lat * Math.PI) / 180) ** 2;
	const capClause =
		`ORDER BY ((latitude - ?) * (latitude - ?) + (longitude - ?) * (longitude - ?) * ?) ASC, id ` +
		`LIMIT ${MAP_RESULT_LIMIT}`;
	params.push(q.lat, q.lat, q.lng, q.lng, lngScale);

	return queryMapData(db, disjuncts.join(' OR '), params, capClause);
}

/**
 * The default ordering+cap for {@link queryMapData}: the alphabetically-first
 * {@link MAP_RESULT_LIMIT} locations. {@link getSearchMapData} passes a
 * distance-ordered clause instead so a global search returns the NEAREST matches.
 */
const DEFAULT_MAP_CAP = `ORDER BY name, id LIMIT ${MAP_RESULT_LIMIT}`;

/**
 * Like {@link DEFAULT_MAP_CAP} but ranks venues that HAVE a menu ahead of those that
 * don't, before the alphabetical tail — so a capped narrow viewport keeps the places
 * we actually have data for. {@link getMapData}'s narrow-viewport path uses this; its
 * wide-viewport (grid) path ranks — including by likes — in SQL instead.
 */
const IMPORTANCE_MAP_CAP = `ORDER BY (menu_id IS NOT NULL) DESC, name, id LIMIT ${MAP_RESULT_LIMIT}`;

/**
 * Shared implementation of {@link getMapData} / {@link getLocationMapData} /
 * {@link getSearchMapData}. `locFilter` is a predicate over the `locations` table
 * (its `?` placeholders bound from the front of `params`); every sub-row read is
 * scoped to the locations it selects — and the menus those locations reference —
 * so neither a viewport box, a single-id lookup nor a search ever pulls an
 * unscoped table.
 *
 * `capClause` is the trailing `ORDER BY … LIMIT …` that both bounds and orders the
 * location set. It is applied IDENTICALLY in `inLocations` and the main row read,
 * so both select the exact same rows. Any `?` placeholders it carries (e.g. a
 * distance anchor) are bound from the END of `params`, AFTER the `locFilter` ones
 * — the two clauses appear in that fixed order in every statement, so one
 * `.bind(...params)` is correct everywhere.
 */
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[],
	capClause: string = DEFAULT_MAP_CAP
): Promise<MapData> {
	// Sub-selects that resolve, from `locFilter`, the in-scope location ids, the
	// menus they reference, and the items on those menus.
	//
	// The location set is capped via `capClause`'s deterministic `ORDER BY … LIMIT`
	// applied IDENTICALLY here in `inLocations` and in the main row read below, so
	// both select the exact same rows — every scoped sub-read therefore covers
	// precisely the returned set.
	// `closed_at IS NULL` hides soft-deleted (permanently-closed) venues from every
	// map/detail/search read this powers (migration 0015). It carries no bind param, so
	// the `.bind(...params)` alignment below is unchanged.
	const inLocations = `SELECT id FROM locations WHERE closed_at IS NULL AND (${locFilter}) ${capClause}`;
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
			.prepare(
				`SELECT ${LOCATION_FIELDS} FROM locations WHERE closed_at IS NULL AND (${locFilter}) ${capClause}`
			)
			.bind(...params)
			.all<LocationRow>(),
		db
			.prepare(
				`SELECT ${ITEM_FIELDS} FROM items WHERE menu_id IN (${inMenus}) ORDER BY menu_id, item_name`
			)
			.bind(...params)
			.all<ItemRow>(),
		db
			.prepare(`SELECT id, currency, last_verified FROM menus WHERE id IN (${inMenus})`)
			.bind(...params)
			.all<{ id: string; currency: string; last_verified: string | null }>(),
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
	const menuMeta: MapData['menuMeta'] = {};
	for (const row of menuCurrencyRows) menuMeta[row.id] = { last_verified: row.last_verified };

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

	return { locations: mapLocations, menus, menuMeta };
}

export async function getLocationById(db: D1Like, id: string): Promise<Location | null> {
	const [row, { results: sources }] = await Promise.all([
		db
			// Closed (soft-deleted) venues are hidden from get_location too (migration 0015);
			// they remain in D1 for analysis and are reopenable via setLocationClosed.
			.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE id = ? AND closed_at IS NULL`)
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

/** Tag/source content for one item write (insert or update). */
interface ItemContent {
	tags?: TagId[];
	optionalTags?: TagId[];
	sources?: Source[];
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
 * can be made vegan on request).
 */
function tagLinkStmts(db: D1Like, itemId: string, content: ItemContent): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];
	for (const tagId of content.tags ?? []) stmts.push(linkTagStmt(db, itemId, tagId, 0));
	for (const tagId of content.optionalTags ?? []) stmts.push(linkTagStmt(db, itemId, tagId, 1));
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
						`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, ?)`
					)
					// last_verified is required (migration 0012); a new private menu is
					// verified as of its creation date.
					.bind(
						privateMenuId,
						loc.name,
						loc.currency ?? DEFAULT_CURRENCY,
						currentVerificationDate()
					)
			);
		}
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, brand_id, menu_id, closed_at, closed_reason)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
					loc.menu_id ?? privateMenuId,
					loc.closed_at ?? null,
					loc.closed_reason ?? null
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

/**
 * Soft-deletes (or reopens) an existing location by flipping its `closed_at`/
 * `closed_reason`, WITHOUT touching the row's likes, menu or sources — the reason a
 * permanently-closed venue is marked rather than {@link deleteLocation}'d (a delete
 * would cascade `liked_locations` away; see migration 0015). Pass `closedAt = null`
 * (and `reason = null`) to reopen. Any `addSources` are appended (deduped by url),
 * e.g. the closure-evidence link. Returns false when no location has that id (nothing
 * written, so a stray source can't be orphaned). For a venue NOT yet on the map, use
 * {@link insertLocations} with `closed_at` set instead (a born-closed tombstone).
 */
export async function setLocationClosed(
	db: D1Like,
	id: string,
	closedAt: number | null,
	reason: string | null,
	addSources?: Source[]
): Promise<boolean> {
	const exists = await db.prepare(`SELECT id FROM locations WHERE id = ?`).bind(id).first();
	if (!exists) return false;
	const stmts: D1PreparedLike[] = [
		db
			.prepare(`UPDATE locations SET closed_at = ?, closed_reason = ? WHERE id = ?`)
			.bind(closedAt, reason, id)
	];
	for (const source of addSources ?? []) {
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
				)
				.bind(id, source.url, source.label ?? null)
		);
	}
	await db.batch(stmts);
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
 * in `patch`), plus full-set replacements for the dietary/course tags and the
 * sources when those are provided (`tags: []`/`sources: []` clear; `addSources`
 * appends instead of replacing). No existence check — callers ({@link updateItem},
 * {@link updateItems}) resolve which ids exist up front so a whole batch stays a
 * single round trip.
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

	// Replace the dietary/course tag set (every tag is dietary/course now, so this
	// clears all of an item's tag links before re-linking the new set).
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
	const before = await getItemById(db, id);
	if (!before) return null;
	const stmts = itemUpdateStmts(db, id, patch);
	// Editing an item refreshes its menu; a move (patch.menu_id) also touches the
	// destination menu, which just gained the item.
	const affectedMenus = new Set([before.menu_id]);
	if (patch.menu_id) affectedMenus.add(patch.menu_id);
	stmts.push(...touchMenuStmts(db, affectedMenus));
	await db.batch(stmts);
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
	menu: Omit<Menu, 'id' | 'sources' | 'currency' | 'last_verified'> & {
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
				// last_verified is always "now": a just-created menu is verified as of its
				// creation, the date is never an agent-supplied parameter, and a real date
				// satisfies migration 0012's non-empty requirement.
				currentVerificationDate()
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
const MENU_COLUMNS = ['brand_id', 'name', 'region', 'currency'] as const;

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
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col] ?? null);
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
 * See {@link applyItemUpdate} for the replace-set semantics of tags/sources.
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
		.prepare(`SELECT id, menu_id FROM items WHERE id IN (${placeholders})`)
		.bind(...ids)
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

/** Deletes an item and its tag/source links (and any per-location overrides). Returns `true` if removed. */
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
