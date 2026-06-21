// ---------------------------------------------------------------------------
// Cloudflare D1 data-access layer.
//
// This module is RUNTIME-AGNOSTIC: it contains no connection of its own. Every
// function takes a `D1Like` handle and is async, so the same code runs against
// either the Worker's D1 binding (`platform.env.DB`) in the deployed app, or the
// HTTP-backed client in `d1-http.ts` used by the MCP server and the seed script.
// Keep it free of `bun:sqlite`, `node:*`, and other non-Worker imports.
// ---------------------------------------------------------------------------

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

export type Category = 'cafe' | 'fast_food' | 'restaurant' | 'bakery';

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

export interface LocationWithMenu extends Location {
	menu: Food[];
}

export interface LocationWithTags extends Location {
	/** Distinct dietary tags offered across this location's menu items. */
	tags: Tag[];
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

// ---------------------------------------------------------------------------
// SQL (D1 enforces foreign keys; schema lives in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

const LOCATION_FIELDS = `id, name, category, latitude, longitude, address, phone, website`;
const FOOD_FIELDS = `id, location_id, item_name, description, ingredients, price`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getAllTags(): Tag[] {
	return TAGS.map((tag) => ({ ...tag }));
}

export async function getLocationsWithTags(db: D1Like): Promise<LocationWithTags[]> {
	const [{ results: locations }, { results: tagRows }, { results: sourceRows }] = await Promise.all(
		[
			db.prepare(`SELECT ${LOCATION_FIELDS} FROM locations ORDER BY name`).all<LocationRow>(),
			// Distinct tags offered across each location's whole menu (for list/map filters).
			db
				.prepare(
					`SELECT DISTINCT f.location_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM food f
				 JOIN food_tags ft ON ft.food_id = f.id
				 JOIN tags t ON t.id = ft.tag_id
				 ORDER BY f.location_id, t.rowid`
				)
				.all<TagRow>(),
			db
				.prepare(`SELECT location_id AS owner_id, url, label FROM location_sources ORDER BY rowid`)
				.all<SourceRow>()
		]
	);

	const tagsByLocation = groupTags(tagRows);
	const sourcesByLocation = groupSources(sourceRows);

	return locations.map((loc) => ({
		...loc,
		tags: tagsByLocation.get(loc.id) ?? [],
		sources: sourcesByLocation.get(loc.id) ?? []
	}));
}

/**
 * Returns every location merged with its full `menu` (each menu item carries its
 * own dietary tags). Built in bulk to avoid an N+1 query per location. Used by
 * the map page to render markers and per-location matching-item lists.
 */
export async function getLocationsWithMenus(db: D1Like): Promise<LocationWithMenu[]> {
	const [
		{ results: locations },
		{ results: foodRows },
		{ results: tagRows },
		{ results: foodSourceRows },
		{ results: locationSourceRows }
	] = await Promise.all([
		db.prepare(`SELECT ${LOCATION_FIELDS} FROM locations ORDER BY name`).all<LocationRow>(),
		db.prepare(`SELECT ${FOOD_FIELDS} FROM food ORDER BY location_id, item_name`).all<FoodRow>(),
		db
			.prepare(
				`SELECT ft.food_id AS owner_id, t.id AS id, t.label AS label, t.kind AS kind
				 FROM food_tags ft
				 JOIN tags t ON t.id = ft.tag_id
				 ORDER BY t.rowid`
			)
			.all<TagRow>(),
		db
			.prepare(`SELECT food_id AS owner_id, url, label FROM food_sources ORDER BY rowid`)
			.all<SourceRow>(),
		db
			.prepare(`SELECT location_id AS owner_id, url, label FROM location_sources ORDER BY rowid`)
			.all<SourceRow>()
	]);

	const tagsByFood = groupTags(tagRows);
	const sourcesByFood = groupSources(foodSourceRows);
	const sourcesByLocation = groupSources(locationSourceRows);

	const menuByLocation = new Map<string, Food[]>();
	for (const row of foodRows) {
		const list = menuByLocation.get(row.location_id) ?? [];
		list.push({
			...row,
			tags: tagsByFood.get(row.id) ?? [],
			sources: sourcesByFood.get(row.id) ?? []
		});
		menuByLocation.set(row.location_id, list);
	}

	return locations.map((loc) => ({
		...loc,
		sources: sourcesByLocation.get(loc.id) ?? [],
		menu: menuByLocation.get(loc.id) ?? []
	}));
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

export async function insertLocation(
	db: D1Like,
	loc: Omit<Location, 'id' | 'sources'> & { id?: string; sources?: Source[] }
): Promise<string> {
	const id = loc.id ?? crypto.randomUUID();
	const stmts: D1PreparedLike[] = [
		db
			.prepare(
				`INSERT INTO locations (id, name, category, latitude, longitude, address, phone, website)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				loc.name,
				loc.category,
				loc.latitude,
				loc.longitude,
				loc.address,
				loc.phone,
				loc.website
			)
	];
	for (const source of loc.sources ?? []) {
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
				)
				.bind(id, source.url, source.label ?? null)
		);
	}
	await db.batch(stmts);
	return id;
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
	'website'
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
