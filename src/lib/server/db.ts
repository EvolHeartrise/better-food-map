/// <reference types="bun-types" />
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';

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
// created from the UI.
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

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

// `bun:sqlite` will not create parent directories, so ensure `data/` exists.
mkdirSync('data', { recursive: true });

export const db: Database = new Database('data/food.db', { create: true });

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Idempotent schema setup. Runs once per import.
db.exec(`
	CREATE TABLE IF NOT EXISTS locations (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		category TEXT,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		address TEXT,
		phone TEXT,
		website TEXT
	);

	CREATE TABLE IF NOT EXISTS food (
		id TEXT PRIMARY KEY,
		location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
		item_name TEXT NOT NULL,
		description TEXT,
		ingredients TEXT,
		price REAL
	);

	CREATE INDEX IF NOT EXISTS idx_food_location_id ON food (location_id);

	CREATE TABLE IF NOT EXISTS tags (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'dietary'
	);

	CREATE TABLE IF NOT EXISTS food_tags (
		food_id TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
		tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (food_id, tag_id)
	);

	CREATE INDEX IF NOT EXISTS idx_food_tags_tag_id ON food_tags (tag_id);

	-- Provenance for each menu item: zero or more source URLs (with optional
	-- labels). The (food_id, url) primary key de-duplicates the same URL per item.
	CREATE TABLE IF NOT EXISTS food_sources (
		food_id TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
		url TEXT NOT NULL,
		label TEXT,
		PRIMARY KEY (food_id, url)
	);

	CREATE INDEX IF NOT EXISTS idx_food_sources_food_id ON food_sources (food_id);

	-- Provenance for each location, same shape as food_sources.
	CREATE TABLE IF NOT EXISTS location_sources (
		location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
		url TEXT NOT NULL,
		label TEXT,
		PRIMARY KEY (location_id, url)
	);

	CREATE INDEX IF NOT EXISTS idx_location_sources_location_id ON location_sources (location_id);
`);

// Migration: databases created before the `description` column existed won't get
// it from CREATE TABLE IF NOT EXISTS, so add it when missing. Referenced by name
// everywhere, so its physical column position doesn't matter.
const hasDescription = db
	.query<{ name: string }, []>(`PRAGMA table_info(food)`)
	.all()
	.some((col) => col.name === 'description');
if (!hasDescription) {
	db.exec(`ALTER TABLE food ADD COLUMN description TEXT`);
}

// Migration: `kind` was added to `tags` after the table first shipped, so
// CREATE TABLE IF NOT EXISTS won't add it to pre-existing databases. Backfill it
// with the 'dietary' default; the upsert below then sets the correct kind.
const hasTagKind = db
	.query<{ name: string }, []>(`PRAGMA table_info(tags)`)
	.all()
	.some((col) => col.name === 'kind');
if (!hasTagKind) {
	db.exec(`ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'dietary'`);
}

// The canonical tags are part of the app contract (not user data), so make sure
// they exist on every startup. Idempotent: re-running keeps labels and kinds in sync.
const upsertTagStmt = db.query<unknown, [string, string, string]>(
	`INSERT INTO tags (id, label, kind) VALUES (?, ?, ?)
	 ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind`
);
for (const tag of TAGS) {
	upsertTagStmt.run(tag.id, tag.label, tag.kind);
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const selectAllLocations = db.query<LocationRow, []>(
	`SELECT id, name, category, latitude, longitude, address, phone, website
	 FROM locations
	 ORDER BY name`
);

const selectLocationById = db.query<LocationRow, [string]>(
	`SELECT id, name, category, latitude, longitude, address, phone, website
	 FROM locations
	 WHERE id = ?`
);

const selectFoodByLocation = db.query<FoodRow, [string]>(
	`SELECT id, location_id, item_name, description, ingredients, price
	 FROM food
	 WHERE location_id = ?
	 ORDER BY item_name`
);

// Tags for every menu item at a location, one row per (food, tag) pair.
const selectTagsByLocation = db.query<
	{ food_id: string; id: TagId; label: string; kind: TagKind },
	[string]
>(
	`SELECT ft.food_id AS food_id, t.id AS id, t.label AS label, t.kind AS kind
	 FROM food_tags ft
	 JOIN tags t ON t.id = ft.tag_id
	 JOIN food f ON f.id = ft.food_id
	 WHERE f.location_id = ?
	 ORDER BY t.rowid`
);

// Distinct tags offered across each location's whole menu (for list/map filters).
const selectLocationTags = db.query<
	{ location_id: string; id: TagId; label: string; kind: TagKind },
	[]
>(
	`SELECT DISTINCT f.location_id AS location_id, t.id AS id, t.label AS label, t.kind AS kind
	 FROM food f
	 JOIN food_tags ft ON ft.food_id = f.id
	 JOIN tags t ON t.id = ft.tag_id
	 ORDER BY f.location_id, t.rowid`
);

// Every menu item across all locations, for building full menus in bulk.
const selectAllFood = db.query<FoodRow, []>(
	`SELECT id, location_id, item_name, description, ingredients, price
	 FROM food
	 ORDER BY location_id, item_name`
);

// Every (food, tag) pair across the whole database, for the bulk menu build.
const selectAllFoodTags = db.query<
	{ food_id: string; id: TagId; label: string; kind: TagKind },
	[]
>(
	`SELECT ft.food_id AS food_id, t.id AS id, t.label AS label, t.kind AS kind
	 FROM food_tags ft
	 JOIN tags t ON t.id = ft.tag_id
	 ORDER BY t.rowid`
);

const insertLocationStmt = db.query<
	unknown,
	[string, string, string | null, number, number, string | null, string | null, string | null]
>(
	`INSERT INTO locations (id, name, category, latitude, longitude, address, phone, website)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertFoodStmt = db.query<
	unknown,
	[string, string, string, string | null, string | null, number | null]
>(
	`INSERT INTO food (id, location_id, item_name, description, ingredients, price)
	 VALUES (?, ?, ?, ?, ?, ?)`
);

const insertFoodTagStmt = db.query<unknown, [string, string]>(
	`INSERT OR IGNORE INTO food_tags (food_id, tag_id) VALUES (?, ?)`
);

const selectFoodById = db.query<FoodRow, [string]>(
	`SELECT id, location_id, item_name, description, ingredients, price
	 FROM food
	 WHERE id = ?`
);

const selectTagsByFood = db.query<{ id: TagId; label: string; kind: TagKind }, [string]>(
	`SELECT t.id AS id, t.label AS label, t.kind AS kind
	 FROM food_tags ft
	 JOIN tags t ON t.id = ft.tag_id
	 WHERE ft.food_id = ?
	 ORDER BY t.rowid`
);

const deleteFoodTagsStmt = db.query<unknown, [string]>(`DELETE FROM food_tags WHERE food_id = ?`);

const deleteLocationStmt = db.query<unknown, [string]>(`DELETE FROM locations WHERE id = ?`);

const deleteFoodStmt = db.query<unknown, [string]>(`DELETE FROM food WHERE id = ?`);

// --- Sources ---------------------------------------------------------------

const selectSourcesByFood = db.query<Source, [string]>(
	`SELECT url, label FROM food_sources WHERE food_id = ? ORDER BY rowid`
);

const selectSourcesByLocation = db.query<Source, [string]>(
	`SELECT url, label FROM location_sources WHERE location_id = ? ORDER BY rowid`
);

// Sources for every menu item at one location, one row per (food, source) pair.
const selectFoodSourcesByLocation = db.query<SourceRow, [string]>(
	`SELECT fs.food_id AS owner_id, fs.url AS url, fs.label AS label
	 FROM food_sources fs
	 JOIN food f ON f.id = fs.food_id
	 WHERE f.location_id = ?
	 ORDER BY fs.rowid`
);

// Every (food, source) pair across the whole database, for the bulk menu build.
const selectAllFoodSources = db.query<SourceRow, []>(
	`SELECT food_id AS owner_id, url, label FROM food_sources ORDER BY rowid`
);

// Every (location, source) pair across the whole database.
const selectAllLocationSources = db.query<SourceRow, []>(
	`SELECT location_id AS owner_id, url, label FROM location_sources ORDER BY rowid`
);

const insertFoodSourceStmt = db.query<unknown, [string, string, string | null]>(
	`INSERT OR IGNORE INTO food_sources (food_id, url, label) VALUES (?, ?, ?)`
);

const insertLocationSourceStmt = db.query<unknown, [string, string, string | null]>(
	`INSERT OR IGNORE INTO location_sources (location_id, url, label) VALUES (?, ?, ?)`
);

const deleteFoodSourcesStmt = db.query<unknown, [string]>(
	`DELETE FROM food_sources WHERE food_id = ?`
);

const deleteLocationSourcesStmt = db.query<unknown, [string]>(
	`DELETE FROM location_sources WHERE location_id = ?`
);

// ---------------------------------------------------------------------------
// Public API (STABLE CONTRACT)
// ---------------------------------------------------------------------------

export function getAllLocations(): Location[] {
	const sourcesByLocation = groupSources(selectAllLocationSources.all());
	return selectAllLocations
		.all()
		.map((loc) => ({ ...loc, sources: sourcesByLocation.get(loc.id) ?? [] }));
}

export function getAllTags(): Tag[] {
	return TAGS.map((tag) => ({ ...tag }));
}

export function getLocationsWithTags(): LocationWithTags[] {
	const locations = selectAllLocations.all();
	const tagRows = selectLocationTags.all();
	const sourcesByLocation = groupSources(selectAllLocationSources.all());

	const tagsByLocation = new Map<string, Tag[]>();
	for (const row of tagRows) {
		const list = tagsByLocation.get(row.location_id) ?? [];
		list.push({ id: row.id, label: row.label, kind: row.kind });
		tagsByLocation.set(row.location_id, list);
	}

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
export function getLocationsWithMenus(): LocationWithMenu[] {
	const locations = selectAllLocations.all();
	const foodRows = selectAllFood.all();
	const tagRows = selectAllFoodTags.all();
	const sourcesByFood = groupSources(selectAllFoodSources.all());
	const sourcesByLocation = groupSources(selectAllLocationSources.all());

	const tagsByFood = new Map<string, Tag[]>();
	for (const row of tagRows) {
		const list = tagsByFood.get(row.food_id) ?? [];
		list.push({ id: row.id, label: row.label, kind: row.kind });
		tagsByFood.set(row.food_id, list);
	}

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

export function getLocationById(id: string): Location | null {
	const row = selectLocationById.get(id);
	if (!row) return null;
	return { ...row, sources: selectSourcesByLocation.all(id) };
}

export function getFoodByLocation(locationId: string): Food[] {
	const rows = selectFoodByLocation.all(locationId);
	const tagRows = selectTagsByLocation.all(locationId);
	const sourcesByFood = groupSources(selectFoodSourcesByLocation.all(locationId));

	const tagsByFood = new Map<string, Tag[]>();
	for (const row of tagRows) {
		const list = tagsByFood.get(row.food_id) ?? [];
		list.push({ id: row.id, label: row.label, kind: row.kind });
		tagsByFood.set(row.food_id, list);
	}

	return rows.map((row) => ({
		...row,
		tags: tagsByFood.get(row.id) ?? [],
		sources: sourcesByFood.get(row.id) ?? []
	}));
}

export function insertLocation(
	loc: Omit<Location, 'id' | 'sources'> & { id?: string; sources?: Source[] }
): string {
	const id = loc.id ?? crypto.randomUUID();
	insertLocationStmt.run(
		id,
		loc.name,
		loc.category,
		loc.latitude,
		loc.longitude,
		loc.address,
		loc.phone,
		loc.website
	);
	for (const source of loc.sources ?? []) {
		insertLocationSourceStmt.run(id, source.url, source.label ?? null);
	}
	return id;
}

/** Arguments accepted by {@link insertFood} / {@link insertFoods}. */
export type FoodInsert = Omit<Food, 'id' | 'tags' | 'description' | 'sources'> & {
	id?: string;
	description?: string | null;
	tags?: TagId[];
	sources?: Source[];
};

export function insertFood(item: FoodInsert): string {
	const id = item.id ?? crypto.randomUUID();
	insertFoodStmt.run(
		id,
		item.location_id,
		item.item_name,
		item.description ?? null,
		item.ingredients,
		item.price
	);
	for (const tagId of item.tags ?? []) {
		insertFoodTagStmt.run(id, tagId);
	}
	for (const source of item.sources ?? []) {
		insertFoodSourceStmt.run(id, source.url, source.label ?? null);
	}
	return id;
}

// Wrapped in a single transaction so a batch insert is all-or-nothing: if any
// item throws, every insert in the batch is rolled back.
const insertFoodsTx = db.transaction((items: FoodInsert[]): string[] => items.map(insertFood));

/**
 * Inserts many menu items in one transaction and returns their ids in input
 * order. Either every item is written or, on any error, none are.
 */
export function insertFoods(items: FoodInsert[]): string[] {
	return insertFoodsTx(items);
}

/** Mutable columns of `locations`, in their physical order. */
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
 * are written. Returns the updated row, or `null` if no location has that id.
 */
export function updateLocation(id: string, patch: Partial<Omit<Location, 'id'>>): Location | null {
	if (!getLocationById(id)) return null;

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of LOCATION_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col]);
		}
	}

	if (assignments.length > 0) {
		values.push(id);
		db.query(`UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
	}

	if (patch.sources !== undefined) {
		deleteLocationSourcesStmt.run(id);
		for (const source of patch.sources) {
			insertLocationSourceStmt.run(id, source.url, source.label ?? null);
		}
	}
	return getLocationById(id);
}

/**
 * Deletes a location and (via `ON DELETE CASCADE`) all of its menu items and
 * their tag links. Returns `true` if a row was removed.
 */
export function deleteLocation(id: string): boolean {
	return deleteLocationStmt.run(id).changes > 0;
}

/** Returns a single menu item with its dietary tags, or `null` if not found. */
export function getFoodById(id: string): Food | null {
	const row = selectFoodById.get(id);
	if (!row) return null;
	return { ...row, tags: selectTagsByFood.all(id), sources: selectSourcesByFood.all(id) };
}

/** Mutable scalar columns of `food`, in their physical order. */
const FOOD_COLUMNS = ['location_id', 'item_name', 'description', 'ingredients', 'price'] as const;

/**
 * Applies a partial update to a menu item. Scalar fields present in `patch` are
 * written; if `patch.tags` is provided, the item's tag set is replaced wholesale
 * (pass `[]` to clear all tags). Returns the updated item, or `null` if no food
 * item has that id.
 */
export function updateFood(
	id: string,
	patch: Partial<Omit<Food, 'id' | 'tags'>> & { tags?: TagId[] }
): Food | null {
	if (!getFoodById(id)) return null;

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of FOOD_COLUMNS) {
		if (patch[col] !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(patch[col]);
		}
	}

	if (assignments.length > 0) {
		values.push(id);
		db.query(`UPDATE food SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
	}

	if (patch.tags !== undefined) {
		deleteFoodTagsStmt.run(id);
		for (const tagId of patch.tags) {
			insertFoodTagStmt.run(id, tagId);
		}
	}

	if (patch.sources !== undefined) {
		deleteFoodSourcesStmt.run(id);
		for (const source of patch.sources) {
			insertFoodSourceStmt.run(id, source.url, source.label ?? null);
		}
	}

	return getFoodById(id);
}

/** Deletes a menu item and its tag links. Returns `true` if a row was removed. */
export function deleteFood(id: string): boolean {
	return deleteFoodStmt.run(id).changes > 0;
}
