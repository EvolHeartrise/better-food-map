// ---------------------------------------------------------------------------
// Cloudflare D1 data-access layer.
//
// This module is RUNTIME-AGNOSTIC: it contains no connection of its own. Every
// function takes a `D1Like` handle and is async, so the same code runs against
// either the Worker's D1 binding (`platform.env.DB`) in the deployed app, or the
// HTTP-backed client in `d1-http.ts` used by the MCP server and the seed script.
// Keep it free of `bun:sqlite`, `node:*`, and other non-Worker imports.
// ---------------------------------------------------------------------------

// Type-only import (erased at build time, so it adds no runtime dependency and
// keeps this module runtime-agnostic). `category.ts` is the canonical, client-safe
// home of the category union; re-exported below as part of this module's contract.
import type { Category } from '../category';

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

// Canonical tag identifiers. App-defined and fixed — tags are NOT user-authored,
// so this union is the single source of truth.
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
export type TagKind = 'dietary' | 'course';

export interface Tag {
	id: TagId;
	label: string;
	kind: TagKind;
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
	address: string | null;
	phone: string | null;
	website: string | null;
	/** Chain this location belongs to, or `null` for an independent venue. */
	brand_id: string | null;
	/** Shared brand menu this location serves, or `null` (independent / own `food`). */
	menu_id: string | null;
	/** Citations for where this location's data came from (may be empty). */
	sources: Source[];
}

export interface Food {
	id: string;
	location_id: string;
	item_name: string;
	/** Short free-text description of the item (may be null). */
	description: string | null;
	ingredients: string | null;
	price: number | null;
	/** Dietary tags applied to this menu item (may be empty). */
	tags: Tag[];
	/** Citations for where this item's data came from (may be empty). */
	sources: Source[];
}

export interface LocationWithTags extends Location {
	/** Distinct dietary tags offered across this location's menu items. */
	tags: Tag[];
}

/**
 * A location plus the raw pieces the client needs to rebuild its menu without
 * the server expanding a shared brand menu onto every branch: its own `food`
 * items and any per-item overrides of the shared menu. See {@link MapData}.
 */
export interface MapLocation extends Location {
	/** This location's own `food` items (empty for a pure chain branch). */
	food: Food[];
	/** Per-item deviations from its shared menu (empty unless it overrides one). */
	overrides: LocationItemOverride[];
}

/**
 * Everything the map page needs in one payload. Each shared brand menu is sent
 * ONCE, keyed by `menu_id`, rather than copied onto every branch that serves it —
 * a 500-branch chain would otherwise ship its whole menu 500 times. The client
 * joins each {@link MapLocation} to its `menus` entry, applying the location's
 * `overrides`, to reconstruct the effective menu (see `resolveMenu` in +page.svelte).
 */
export interface MapData {
	locations: MapLocation[];
	/** Shared brand menus, each item resolved once (tags + merged sources), keyed by menu_id. */
	menus: Record<string, MenuItem[]>;
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
// either serves a shared brand menu (locations.menu_id) or its own `food`.
// ---------------------------------------------------------------------------

/** A restaurant chain / brand (e.g. McDonald's). Independent venues have none. */
export interface Brand {
	id: string;
	name: string;
	website: string | null;
	/** URL of the brand's logo/marker image, or null. */
	logo_url: string | null;
}

/** A regionally-scoped set of items shared across a brand's locations. */
export interface Menu {
	id: string;
	/** Owning brand, or null for a standalone menu not tied to a chain. */
	brand_id: string | null;
	/** Display name, e.g. "Subway UK". */
	name: string;
	/** Free-form scope label, e.g. "GB", "US-CA", "Canada". */
	region: string | null;
	/** ISO date the menu was last checked against the source (chain menus go stale). */
	last_verified: string | null;
	/** Citations for where this menu's data came from (may be empty). */
	sources: Source[];
}

/** A canonical item on a {@link Menu}; defined once, served by many locations. */
export interface MenuItem {
	id: string;
	menu_id: string;
	item_name: string;
	description: string | null;
	ingredients: string | null;
	/** Default price; a location may override it (see {@link LocationItemOverride}). */
	price: number | null;
	tags: Tag[];
	sources: Source[];
}

export interface MenuWithItems extends Menu {
	items: MenuItem[];
}

/** Lightweight menu listing row (no items/sources), with an item count. */
export interface MenuSummary {
	id: string;
	brand_id: string | null;
	name: string;
	region: string | null;
	last_verified: string | null;
	item_count: number;
}

/** A single location's deviation from its shared menu, stored only where it differs. */
export interface LocationItemOverride {
	location_id: string;
	menu_item_id: string;
	/** `false` = not served here; `null` = inherit the menu default (served). */
	available: boolean | null;
	/** Overriding price here, or `null` to inherit the menu item's price. */
	price: number | null;
}

// The canonical tag list. Order here is the display/filter order on the
// frontend (dietary tags first, then course tags). Tags are app-defined, never
// created from the UI. The same list is seeded into D1 by migrations/0001_init.sql.
export const TAGS: readonly Tag[] = [
	{ id: 'vegan', label: 'Vegan', kind: 'dietary' },
	{ id: 'vegetarian', label: 'Vegetarian', kind: 'dietary' },
	{ id: 'gluten_free', label: 'Gluten-free', kind: 'dietary' },
	{ id: 'dairy_free', label: 'Dairy-free', kind: 'dietary' },
	{ id: 'nut_free', label: 'Nut-free', kind: 'dietary' },
	{ id: 'halal', label: 'Halal', kind: 'dietary' },
	{ id: 'dessert', label: 'Dessert', kind: 'course' },
	{ id: 'drink', label: 'Drink', kind: 'course' }
];

/** Internal raw shape of a `food` row before its tags and sources are attached. */
type FoodRow = Omit<Food, 'tags' | 'sources'>;

/** Internal raw shape of a `menu_items` row before its tags and sources are attached. */
type MenuItemRow = Omit<MenuItem, 'tags' | 'sources'>;

/** Raw `location_item_overrides` row (`available` stored as 0/1/NULL). */
interface OverrideRow {
	location_id: string;
	menu_item_id: string;
	available: number | null;
	price: number | null;
}

/** Internal raw shape of a `locations` row before its sources are attached. */
type LocationRow = Omit<Location, 'sources'>;

/** Raw `*_sources` row keyed by its owner id (food_id or location_id). */
interface SourceRow {
	owner_id: string;
	url: string;
	label: string | null;
}

/** A (food/location, tag) join row, used when grouping tags by owner. */
interface TagRow {
	owner_id: string;
	id: TagId;
	label: string;
	kind: TagKind;
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

/** Groups (owner, tag) join rows into a tag list per owner, preserving order. */
function groupTags(rows: TagRow[]): Map<string, Tag[]> {
	const byOwner = new Map<string, Tag[]>();
	for (const row of rows) {
		const list = byOwner.get(row.owner_id) ?? [];
		list.push({ id: row.id, label: row.label, kind: row.kind });
		byOwner.set(row.owner_id, list);
	}
	return byOwner;
}

/**
 * Like {@link groupTags} but drops repeats of the same tag id per owner — used
 * when a location's tags are unioned from two sources (own `food` + brand menu).
 */
function groupTagsDistinct(rows: TagRow[]): Map<string, Tag[]> {
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
		list.push({ id: row.id, label: row.label, kind: row.kind });
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
// SQL (D1 enforces foreign keys; schema lives in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

const LOCATION_FIELDS = `id, name, category, latitude, longitude, address, phone, website, brand_id, menu_id`;
const FOOD_FIELDS = `id, location_id, item_name, description, ingredients, price`;
const MENU_ITEM_FIELDS = `id, menu_id, item_name, description, ingredients, price`;

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

export async function getLocationsWithTags(db: D1Like): Promise<LocationWithTags[]> {
	const [
		{ results: locations },
		{ results: foodTagRows },
		{ results: menuTagRows },
		{ results: sourceRows }
	] = await Promise.all([
		db.prepare(`SELECT ${LOCATION_FIELDS} FROM locations ORDER BY name`).all<LocationRow>(),
		// Tags from a location's own `food` items.
		db
			.prepare(
				`SELECT DISTINCT f.location_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM food f
				 JOIN food_tags ft ON ft.food_id = f.id
				 JOIN tags t ON t.id = ft.tag_id
				 ORDER BY f.location_id, t.rowid`
			)
			.all<TagRow>(),
		// Tags from the shared brand menu a chain location serves, excluding items
		// it has overridden to unavailable.
		db
			.prepare(
				`SELECT DISTINCT l.id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM locations l
				 JOIN menu_items mi ON mi.menu_id = l.menu_id
				 JOIN menu_item_tags mit ON mit.menu_item_id = mi.id
				 JOIN tags t ON t.id = mit.tag_id
				 LEFT JOIN location_item_overrides o
					ON o.location_id = l.id AND o.menu_item_id = mi.id
				 WHERE l.menu_id IS NOT NULL AND (o.available IS NULL OR o.available <> 0)
				 ORDER BY l.id, t.rowid`
			)
			.all<TagRow>(),
		db
			.prepare(`SELECT location_id AS owner_id, url, label FROM location_sources ORDER BY rowid`)
			.all<SourceRow>()
	]);

	const tagsByLocation = groupTagsDistinct([...foodTagRows, ...menuTagRows]);
	const sourcesByLocation = groupSources(sourceRows);

	return locations.map((loc) => ({
		...loc,
		tags: tagsByLocation.get(loc.id) ?? [],
		sources: sourcesByLocation.get(loc.id) ?? []
	}));
}

/**
 * Returns everything the map page needs for the given viewport in one payload
 * (see {@link MapData}): every location inside `bounds` with its own `food` items
 * and per-item overrides, plus each shared brand menu those branches reference
 * resolved ONCE (keyed by menu_id, each item carrying its tags and merged
 * sources). The client joins the two — applying each location's overrides
 * (unavailable items dropped, overridden prices used) — to reconstruct the
 * effective menu, so a shared chain menu travels the wire a single time instead
 * of being copied onto every branch that serves it.
 *
 * Scoping the read to the visible box keeps the payload bounded as the dataset
 * grows to whole countries — only what's on screen is fetched — and at most
 * {@link MAP_RESULT_LIMIT} locations (the alphabetically-first) are returned for
 * any one box, so a zoomed-out view stays bounded too. Built in bulk to avoid an
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
 * {@link MapData} shape (so the client can rebuild its menu with the same logic).
 * Used by the map's detail view to resolve a location that isn't in the current
 * viewport — e.g. a shared `/locations/<id>` link, or one panned off screen while
 * its details are open. Yields an empty payload if no location has that id.
 */
export function getLocationMapData(db: D1Like, id: string): Promise<MapData> {
	return queryMapData(db, `id = ?`, [id]);
}

/**
 * Shared implementation of {@link getMapData} / {@link getLocationMapData}.
 * `locFilter` is a predicate over the `locations` table (its `?` placeholders
 * bound from `params`); every sub-row read is scoped to the locations it selects
 * — and, for chain branches, the menus those locations reference — so neither a
 * viewport box nor a single-id lookup ever pulls an unscoped table.
 */
async function queryMapData(
	db: D1Like,
	locFilter: string,
	params: (string | number)[]
): Promise<MapData> {
	// Sub-selects that resolve, from `locFilter`, the in-scope location ids, the
	// menus they reference, and (transitively) their food rows and menu items.
	//
	// The location set is capped at MAP_RESULT_LIMIT via a deterministic
	// `ORDER BY name, id LIMIT` applied IDENTICALLY here in `inLocations` and in
	// the main row read below, so both select the exact same rows — every scoped
	// sub-read (food, sources, overrides, and the menus those locations reference,
	// via `id IN (inLocations)`) therefore covers precisely the returned set. The
	// LIMIT is a trusted integer literal, so it is interpolated rather than bound;
	// this leaves each statement's placeholder count unchanged, keeping the shared
	// `.bind(...params)` correct.
	const capClause = `ORDER BY name, id LIMIT ${MAP_RESULT_LIMIT}`;
	const inLocations = `SELECT id FROM locations WHERE ${locFilter} ${capClause}`;
	const inMenus = `SELECT DISTINCT menu_id FROM locations WHERE menu_id IS NOT NULL AND id IN (${inLocations})`;
	const inFood = `SELECT f.id FROM food f WHERE f.location_id IN (${inLocations})`;
	const inMenuItems = `SELECT mi.id FROM menu_items mi WHERE mi.menu_id IN (${inMenus})`;

	const [
		{ results: locations },
		{ results: foodRows },
		{ results: tagRows },
		{ results: foodSourceRows },
		{ results: locationSourceRows },
		{ results: menuItemRows },
		{ results: menuItemTagRows },
		{ results: menuItemSourceRows },
		{ results: menuSourceRows },
		{ results: overrideRows }
	] = await Promise.all([
		db
			.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE ${locFilter} ${capClause}`)
			.bind(...params)
			.all<LocationRow>(),
		db
			.prepare(
				`SELECT ${FOOD_FIELDS} FROM food WHERE location_id IN (${inLocations}) ORDER BY location_id, item_name`
			)
			.bind(...params)
			.all<FoodRow>(),
		db
			.prepare(
				`SELECT ft.food_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM food_tags ft
				 JOIN tags t ON t.id = ft.tag_id
				 WHERE ft.food_id IN (${inFood})
				 ORDER BY t.rowid`
			)
			.bind(...params)
			.all<TagRow>(),
		db
			.prepare(
				`SELECT food_id AS owner_id, url, label FROM food_sources
				 WHERE food_id IN (${inFood}) ORDER BY rowid`
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
				`SELECT ${MENU_ITEM_FIELDS} FROM menu_items
				 WHERE menu_id IN (${inMenus}) ORDER BY menu_id, item_name`
			)
			.bind(...params)
			.all<MenuItemRow>(),
		db
			.prepare(
				`SELECT mit.menu_item_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM menu_item_tags mit
				 JOIN tags t ON t.id = mit.tag_id
				 WHERE mit.menu_item_id IN (${inMenuItems})
				 ORDER BY t.rowid`
			)
			.bind(...params)
			.all<TagRow>(),
		db
			.prepare(
				`SELECT menu_item_id AS owner_id, url, label FROM menu_item_sources
				 WHERE menu_item_id IN (${inMenuItems}) ORDER BY rowid`
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
				`SELECT location_id, menu_item_id, available, price FROM location_item_overrides
				 WHERE location_id IN (${inLocations}) ORDER BY rowid`
			)
			.bind(...params)
			.all<OverrideRow>()
	]);

	const tagsByFood = groupTags(tagRows);
	const sourcesByFood = groupSources(foodSourceRows);
	const sourcesByLocation = groupSources(locationSourceRows);

	// Each location's own `food` rows, in Food shape.
	const ownFoodByLocation = new Map<string, Food[]>();
	for (const row of foodRows) {
		const list = ownFoodByLocation.get(row.location_id) ?? [];
		list.push({
			...row,
			tags: tagsByFood.get(row.id) ?? [],
			sources: sourcesByFood.get(row.id) ?? []
		});
		ownFoodByLocation.set(row.location_id, list);
	}

	// Resolve each shared menu item once (tags + item sources, with the menu-level
	// source appended) and group by menu. The client applies the per-location
	// price/availability deltas as it expands a menu onto each branch.
	const tagsByMenuItem = groupTags(menuItemTagRows);
	const sourcesByMenuItem = groupSources(menuItemSourceRows);
	const sourcesByMenu = groupSources(menuSourceRows);
	const menus: Record<string, MenuItem[]> = {};
	for (const row of menuItemRows) {
		(menus[row.menu_id] ??= []).push({
			id: row.id,
			menu_id: row.menu_id,
			item_name: row.item_name,
			description: row.description,
			ingredients: row.ingredients,
			price: row.price,
			tags: tagsByMenuItem.get(row.id) ?? [],
			sources: mergeSources(
				sourcesByMenuItem.get(row.id) ?? [],
				sourcesByMenu.get(row.menu_id) ?? []
			)
		});
	}

	// Overrides grouped by location, with `available` as the public boolean|null.
	const overridesByLocation = new Map<string, LocationItemOverride[]>();
	for (const row of overrideRows) {
		const list = overridesByLocation.get(row.location_id) ?? [];
		list.push({
			location_id: row.location_id,
			menu_item_id: row.menu_item_id,
			available: row.available === null ? null : row.available !== 0,
			price: row.price
		});
		overridesByLocation.set(row.location_id, list);
	}

	const mapLocations: MapLocation[] = locations.map((loc) => ({
		...loc,
		sources: sourcesByLocation.get(loc.id) ?? [],
		food: ownFoodByLocation.get(loc.id) ?? [],
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
	return { ...row, sources };
}

export async function getFoodByLocation(db: D1Like, locationId: string): Promise<Food[]> {
	const [{ results: rows }, { results: tagRows }, { results: sourceRows }] = await Promise.all([
		db
			.prepare(`SELECT ${FOOD_FIELDS} FROM food WHERE location_id = ? ORDER BY item_name`)
			.bind(locationId)
			.all<FoodRow>(),
		db
			.prepare(
				`SELECT ft.food_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM food_tags ft
				 JOIN tags t ON t.id = ft.tag_id
				 JOIN food f ON f.id = ft.food_id
				 WHERE f.location_id = ?
				 ORDER BY t.rowid`
			)
			.bind(locationId)
			.all<TagRow>(),
		db
			.prepare(
				`SELECT fs.food_id AS owner_id, fs.url AS url, fs.label AS label
				 FROM food_sources fs
				 JOIN food f ON f.id = fs.food_id
				 WHERE f.location_id = ?
				 ORDER BY fs.rowid`
			)
			.bind(locationId)
			.all<SourceRow>()
	]);

	const tagsByFood = groupTags(tagRows);
	const sourcesByFood = groupSources(sourceRows);

	return rows.map((row) => ({
		...row,
		tags: tagsByFood.get(row.id) ?? [],
		sources: sourcesByFood.get(row.id) ?? []
	}));
}

/** Returns a single menu item with its dietary tags and sources, or `null`. */
export async function getFoodById(db: D1Like, id: string): Promise<Food | null> {
	const [row, { results: tags }, { results: sources }] = await Promise.all([
		db.prepare(`SELECT ${FOOD_FIELDS} FROM food WHERE id = ?`).bind(id).first<FoodRow>(),
		db
			.prepare(
				`SELECT t.id AS id, t.label AS label, t.kind AS kind
				 FROM food_tags ft
				 JOIN tags t ON t.id = ft.tag_id
				 WHERE ft.food_id = ?
				 ORDER BY t.rowid`
			)
			.bind(id)
			.all<Tag>(),
		db
			.prepare(`SELECT url, label FROM food_sources WHERE food_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	return { ...row, tags, sources };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertLocations} (one per location). */
export type LocationInsert = Omit<Location, 'id' | 'sources' | 'brand_id' | 'menu_id'> & {
	id?: string;
	brand_id?: string | null;
	menu_id?: string | null;
	sources?: Source[];
};

/**
 * Inserts many locations (with their sources) in one atomic batch and returns
 * their ids in input order, mirroring {@link insertFoods}: either every location
 * is written or, on any error, none are. Pass a single location to add just one.
 * Ideal for backfilling a chain's branches — give each the same `brand_id`/
 * `menu_id` so they all serve the shared menu.
 */
export async function insertLocations(db: D1Like, locs: LocationInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const loc of locs) {
		const id = loc.id ?? crypto.randomUUID();
		ids.push(id);
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, name, category, latitude, longitude, address, phone, website, brand_id, menu_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					loc.name,
					loc.category,
					loc.latitude,
					loc.longitude,
					loc.address,
					loc.phone,
					loc.website,
					loc.brand_id ?? null,
					loc.menu_id ?? null
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
	}
	await db.batch(stmts);
	return ids;
}

/** Arguments accepted by {@link insertFoods}. */
export type FoodInsert = Omit<Food, 'id' | 'tags' | 'description' | 'sources'> & {
	id?: string;
	description?: string | null;
	tags?: TagId[];
	sources?: Source[];
};

/**
 * Inserts many menu items in one atomic batch and returns their ids in input
 * order. Either every item (with its tags and sources) is written or, on any
 * error, none are. Ids are generated up front so the result needs no round-trip.
 */
export async function insertFoods(db: D1Like, items: FoodInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		stmts.push(
			db
				.prepare(
					`INSERT INTO food (id, location_id, item_name, description, ingredients, price)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					item.location_id,
					item.item_name,
					item.description ?? null,
					item.ingredients,
					item.price
				)
		);
		for (const tagId of item.tags ?? []) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO food_tags (food_id, tag_id) VALUES (?, ?)`)
					.bind(id, tagId)
			);
		}
		for (const source of item.sources ?? []) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO food_sources (food_id, url, label) VALUES (?, ?, ?)`)
					.bind(id, source.url, source.label ?? null)
			);
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
	'address',
	'phone',
	'website',
	'brand_id',
	'menu_id'
] as const;

/**
 * Applies a partial update to a location. Only the fields present in `patch`
 * are written; if `patch.sources` is given it replaces the whole source set
 * (pass `[]` to clear). Returns the updated row, or `null` if no location has
 * that id. The scalar update and source replacement run as one atomic batch.
 */
export async function updateLocation(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Location, 'id'>>
): Promise<Location | null> {
	if (!(await getLocationById(db, id))) return null;

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
			db.prepare(`UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}

	if (patch.sources !== undefined) {
		stmts.push(db.prepare(`DELETE FROM location_sources WHERE location_id = ?`).bind(id));
		for (const source of patch.sources) {
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
					)
					.bind(id, source.url, source.label ?? null)
			);
		}
	}

	if (stmts.length > 0) await db.batch(stmts);
	return getLocationById(db, id);
}

/** Mutable scalar columns of `food`. */
const FOOD_COLUMNS = ['location_id', 'item_name', 'description', 'ingredients', 'price'] as const;

/**
 * Applies a partial update to a menu item. Scalar fields present in `patch` are
 * written; if `patch.tags` / `patch.sources` is provided that whole set is
 * replaced (pass `[]` to clear). Returns the updated item, or `null` if no food
 * item has that id. All sub-statements run as one atomic batch.
 */
export async function updateFood(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Food, 'id' | 'tags'>> & { tags?: TagId[] }
): Promise<Food | null> {
	if (!(await getFoodById(db, id))) return null;

	const stmts: D1PreparedLike[] = [];

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of FOOD_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col]);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE food SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}

	if (patch.tags !== undefined) {
		stmts.push(db.prepare(`DELETE FROM food_tags WHERE food_id = ?`).bind(id));
		for (const tagId of patch.tags) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO food_tags (food_id, tag_id) VALUES (?, ?)`)
					.bind(id, tagId)
			);
		}
	}

	if (patch.sources !== undefined) {
		stmts.push(db.prepare(`DELETE FROM food_sources WHERE food_id = ?`).bind(id));
		for (const source of patch.sources) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO food_sources (food_id, url, label) VALUES (?, ?, ?)`)
					.bind(id, source.url, source.label ?? null)
			);
		}
	}

	if (stmts.length > 0) await db.batch(stmts);
	return getFoodById(db, id);
}

/**
 * Deletes a location and (via `ON DELETE CASCADE`) all of its menu items and
 * their tag/source links. Returns `true` if a row was removed.
 */
export async function deleteLocation(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM locations WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

/** Deletes a menu item and its tag/source links. Returns `true` if removed. */
export async function deleteFood(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM food WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
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
 * Any locations referencing it revert to independent (`brand_id`/`menu_id` set to
 * NULL by `ON DELETE SET NULL`). Returns `true` if a row was removed.
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

const MENU_FIELDS = `id, brand_id, name, region, last_verified`;

/** Lists menus (no items) with an item count, optionally filtered by brand. */
export async function getMenus(db: D1Like, brandId?: string): Promise<MenuSummary[]> {
	const sql =
		`SELECT m.id, m.brand_id, m.name, m.region, m.last_verified, COUNT(mi.id) AS item_count
		 FROM menus m LEFT JOIN menu_items mi ON mi.menu_id = m.id` +
		(brandId ? ` WHERE m.brand_id = ?` : ``) +
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

/** Returns all items of a menu, each with its tags and sources (menu-level + item-level). */
async function getMenuItemsByMenu(db: D1Like, menuId: string): Promise<MenuItem[]> {
	const [
		{ results: rows },
		{ results: tagRows },
		{ results: itemSourceRows },
		{ results: menuSourceRows }
	] = await Promise.all([
		db
			.prepare(`SELECT ${MENU_ITEM_FIELDS} FROM menu_items WHERE menu_id = ? ORDER BY item_name`)
			.bind(menuId)
			.all<MenuItemRow>(),
		db
			.prepare(
				`SELECT mit.menu_item_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
					 FROM menu_item_tags mit
					 JOIN tags t ON t.id = mit.tag_id
					 JOIN menu_items mi ON mi.id = mit.menu_item_id
					 WHERE mi.menu_id = ?
					 ORDER BY t.rowid`
			)
			.bind(menuId)
			.all<TagRow>(),
		db
			.prepare(
				`SELECT ms.menu_item_id AS owner_id, ms.url AS url, ms.label AS label
					 FROM menu_item_sources ms
					 JOIN menu_items mi ON mi.id = ms.menu_item_id
					 WHERE mi.menu_id = ?
					 ORDER BY ms.rowid`
			)
			.bind(menuId)
			.all<SourceRow>(),
		db
			.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(menuId)
			.all<Source>()
	]);

	const tagsByItem = groupTags(tagRows);
	const sourcesByItem = groupSources(itemSourceRows);
	return rows.map((row) => ({
		...row,
		tags: tagsByItem.get(row.id) ?? [],
		sources: mergeSources(sourcesByItem.get(row.id) ?? [], menuSourceRows)
	}));
}

export async function getMenuWithItems(db: D1Like, id: string): Promise<MenuWithItems | null> {
	const menu = await getMenuById(db, id);
	if (!menu) return null;
	return { ...menu, items: await getMenuItemsByMenu(db, id) };
}

export async function insertMenu(
	db: D1Like,
	menu: Omit<Menu, 'id' | 'sources'> & { id?: string; sources?: Source[] }
): Promise<string> {
	const id = menu.id ?? crypto.randomUUID();
	const stmts: D1PreparedLike[] = [
		db
			.prepare(
				`INSERT INTO menus (id, brand_id, name, region, last_verified) VALUES (?, ?, ?, ?, ?)`
			)
			.bind(id, menu.brand_id ?? null, menu.name, menu.region ?? null, menu.last_verified ?? null)
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

const MENU_COLUMNS = ['brand_id', 'name', 'region', 'last_verified'] as const;

/**
 * Partial update of a menu. Scalar fields present in `patch` are written; if
 * `patch.sources` is given it replaces the whole source set (pass `[]` to clear).
 * Returns the updated menu, or `null` if no menu has that id.
 */
export async function updateMenu(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Menu, 'id'>>
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
	if (patch.sources !== undefined) {
		stmts.push(db.prepare(`DELETE FROM menu_sources WHERE menu_id = ?`).bind(id));
		for (const source of patch.sources) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
					.bind(id, source.url, source.label ?? null)
			);
		}
	}
	if (stmts.length > 0) await db.batch(stmts);
	return getMenuById(db, id);
}

/**
 * Deletes a menu and (by cascade) its items and their tag/source links. Any
 * locations serving it revert to independent (`menu_id` set NULL). Returns
 * `true` if a row was removed.
 */
export async function deleteMenu(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM menus WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Menu items (shared, belong to a menu — cf. `food`, which belongs to a location)
// ---------------------------------------------------------------------------

/** Returns a single menu item with its dietary tags and sources, or `null`. */
export async function getMenuItemById(db: D1Like, id: string): Promise<MenuItem | null> {
	const [row, { results: tags }, { results: itemSources }] = await Promise.all([
		db
			.prepare(`SELECT ${MENU_ITEM_FIELDS} FROM menu_items WHERE id = ?`)
			.bind(id)
			.first<MenuItemRow>(),
		db
			.prepare(
				`SELECT t.id AS id, t.label AS label, t.kind AS kind
				 FROM menu_item_tags mit
				 JOIN tags t ON t.id = mit.tag_id
				 WHERE mit.menu_item_id = ?
				 ORDER BY t.rowid`
			)
			.bind(id)
			.all<Tag>(),
		db
			.prepare(`SELECT url, label FROM menu_item_sources WHERE menu_item_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	const { results: menuSources } = await db
		.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
		.bind(row.menu_id)
		.all<Source>();
	return { ...row, tags, sources: mergeSources(itemSources, menuSources) };
}

/** Arguments accepted by {@link insertMenuItems}. */
export type MenuItemInsert = Omit<MenuItem, 'id' | 'tags' | 'description' | 'sources'> & {
	id?: string;
	description?: string | null;
	tags?: TagId[];
	sources?: Source[];
};

/**
 * Inserts many menu items in one atomic batch and returns their ids in input
 * order. Mirrors {@link insertFoods}, but items belong to a menu (shared across
 * every location that serves it) rather than to a single location.
 */
export async function insertMenuItems(db: D1Like, items: MenuItemInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		stmts.push(
			db
				.prepare(
					`INSERT INTO menu_items (id, menu_id, item_name, description, ingredients, price)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					item.menu_id,
					item.item_name,
					item.description ?? null,
					item.ingredients,
					item.price
				)
		);
		for (const tagId of item.tags ?? []) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO menu_item_tags (menu_item_id, tag_id) VALUES (?, ?)`)
					.bind(id, tagId)
			);
		}
		for (const source of item.sources ?? []) {
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO menu_item_sources (menu_item_id, url, label) VALUES (?, ?, ?)`
					)
					.bind(id, source.url, source.label ?? null)
			);
		}
	}
	await db.batch(stmts);
	return ids;
}

const MENU_ITEM_COLUMNS = ['menu_id', 'item_name', 'description', 'ingredients', 'price'] as const;

/**
 * Partial update of a menu item (shared across all locations serving its menu).
 * Scalar fields present in `patch` are written; if `patch.tags` / `patch.sources`
 * is given that whole set is replaced (pass `[]` to clear). Returns the updated
 * item, or `null` if no menu item has that id.
 */
export async function updateMenuItem(
	db: D1Like,
	id: string,
	patch: Partial<Omit<MenuItem, 'id' | 'tags'>> & { tags?: TagId[] }
): Promise<MenuItem | null> {
	if (!(await getMenuItemById(db, id))) return null;

	const stmts: D1PreparedLike[] = [];
	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of MENU_ITEM_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col]);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE menu_items SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}
	if (patch.tags !== undefined) {
		stmts.push(db.prepare(`DELETE FROM menu_item_tags WHERE menu_item_id = ?`).bind(id));
		for (const tagId of patch.tags) {
			stmts.push(
				db
					.prepare(`INSERT OR IGNORE INTO menu_item_tags (menu_item_id, tag_id) VALUES (?, ?)`)
					.bind(id, tagId)
			);
		}
	}
	if (patch.sources !== undefined) {
		stmts.push(db.prepare(`DELETE FROM menu_item_sources WHERE menu_item_id = ?`).bind(id));
		for (const source of patch.sources) {
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO menu_item_sources (menu_item_id, url, label) VALUES (?, ?, ?)`
					)
					.bind(id, source.url, source.label ?? null)
			);
		}
	}
	if (stmts.length > 0) await db.batch(stmts);
	return getMenuItemById(db, id);
}

/** Deletes a menu item and its tag/source links (and any per-location overrides). */
export async function deleteMenuItem(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM menu_items WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Per-location overrides of shared menu items
// ---------------------------------------------------------------------------

/** Returns a location's overrides of its shared-menu items (empty if none). */
export async function getLocationItemOverrides(
	db: D1Like,
	locationId: string
): Promise<LocationItemOverride[]> {
	const { results } = await db
		.prepare(
			`SELECT location_id, menu_item_id, available, price
			 FROM location_item_overrides WHERE location_id = ? ORDER BY rowid`
		)
		.bind(locationId)
		.all<OverrideRow>();
	return results.map((r) => ({
		location_id: r.location_id,
		menu_item_id: r.menu_item_id,
		available: r.available === null ? null : r.available !== 0,
		price: r.price
	}));
}

/**
 * Creates or replaces a location's override of one shared menu item. `available`
 * `false` hides the item at this location; `price` overrides its price here.
 * Pass `null` for either to inherit the menu default.
 */
export async function setLocationItemOverride(
	db: D1Like,
	locationId: string,
	menuItemId: string,
	override: { available?: boolean | null; price?: number | null }
): Promise<void> {
	const available =
		override.available === undefined || override.available === null
			? null
			: override.available
				? 1
				: 0;
	await db
		.prepare(
			`INSERT INTO location_item_overrides (location_id, menu_item_id, available, price)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(location_id, menu_item_id)
			 DO UPDATE SET available = excluded.available, price = excluded.price`
		)
		.bind(locationId, menuItemId, available, override.price ?? null)
		.run();
}

/** Removes an override so the location inherits the menu default again. */
export async function deleteLocationItemOverride(
	db: D1Like,
	locationId: string,
	menuItemId: string
): Promise<boolean> {
	const res = await db
		.prepare(`DELETE FROM location_item_overrides WHERE location_id = ? AND menu_item_id = ?`)
		.bind(locationId, menuItemId)
		.run();
	return res.meta.changes > 0;
}
