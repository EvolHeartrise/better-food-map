/// <reference types="bun-types" />
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types (STABLE CONTRACT — other agents depend on these exact names)
// ---------------------------------------------------------------------------

export type Category = 'cafe' | 'fast_food' | 'restaurant';

// Canonical dietary tag identifiers. App-defined and fixed — tags are NOT
// user-authored, so this union is the single source of truth.
export type TagId = 'vegan' | 'vegetarian' | 'gluten_free' | 'dairy_free' | 'nut_free' | 'halal';

export interface Tag {
	id: TagId;
	label: string;
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
}

export interface LocationWithMenu extends Location {
	menu: Food[];
}

export interface LocationWithTags extends Location {
	/** Distinct dietary tags offered across this location's menu items. */
	tags: Tag[];
}

// The canonical tag list. Order here is the display/filter order on the
// frontend. Tags are app-defined, never created from the UI.
export const TAGS: readonly Tag[] = [
	{ id: 'vegan', label: 'Vegan' },
	{ id: 'vegetarian', label: 'Vegetarian' },
	{ id: 'gluten_free', label: 'Gluten-free' },
	{ id: 'dairy_free', label: 'Dairy-free' },
	{ id: 'nut_free', label: 'Nut-free' },
	{ id: 'halal', label: 'Halal' }
];

/** Internal raw shape of a `food` row before its tags are attached. */
type FoodRow = Omit<Food, 'tags'>;

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
		label TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS food_tags (
		food_id TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
		tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (food_id, tag_id)
	);

	CREATE INDEX IF NOT EXISTS idx_food_tags_tag_id ON food_tags (tag_id);
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

// The canonical tags are part of the app contract (not user data), so make sure
// they exist on every startup. Idempotent: re-running keeps labels in sync.
const upsertTagStmt = db.query<unknown, [string, string]>(
	`INSERT INTO tags (id, label) VALUES (?, ?)
	 ON CONFLICT(id) DO UPDATE SET label = excluded.label`
);
for (const tag of TAGS) {
	upsertTagStmt.run(tag.id, tag.label);
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const selectAllLocations = db.query<Location, []>(
	`SELECT id, name, category, latitude, longitude, address, phone, website
	 FROM locations
	 ORDER BY name`
);

const selectLocationById = db.query<Location, [string]>(
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
const selectTagsByLocation = db.query<{ food_id: string; id: TagId; label: string }, [string]>(
	`SELECT ft.food_id AS food_id, t.id AS id, t.label AS label
	 FROM food_tags ft
	 JOIN tags t ON t.id = ft.tag_id
	 JOIN food f ON f.id = ft.food_id
	 WHERE f.location_id = ?
	 ORDER BY t.rowid`
);

// Distinct tags offered across each location's whole menu (for list/map filters).
const selectLocationTags = db.query<{ location_id: string; id: TagId; label: string }, []>(
	`SELECT DISTINCT f.location_id AS location_id, t.id AS id, t.label AS label
	 FROM food f
	 JOIN food_tags ft ON ft.food_id = f.id
	 JOIN tags t ON t.id = ft.tag_id
	 ORDER BY f.location_id, t.rowid`
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

// ---------------------------------------------------------------------------
// Public API (STABLE CONTRACT)
// ---------------------------------------------------------------------------

export function getAllLocations(): Location[] {
	return selectAllLocations.all();
}

export function getAllTags(): Tag[] {
	return TAGS.map((tag) => ({ ...tag }));
}

export function getLocationsWithTags(): LocationWithTags[] {
	const locations = selectAllLocations.all();
	const tagRows = selectLocationTags.all();

	const tagsByLocation = new Map<string, Tag[]>();
	for (const row of tagRows) {
		const list = tagsByLocation.get(row.location_id) ?? [];
		list.push({ id: row.id, label: row.label });
		tagsByLocation.set(row.location_id, list);
	}

	return locations.map((loc) => ({ ...loc, tags: tagsByLocation.get(loc.id) ?? [] }));
}

export function getLocationById(id: string): Location | null {
	return selectLocationById.get(id) ?? null;
}

export function getFoodByLocation(locationId: string): Food[] {
	const rows = selectFoodByLocation.all(locationId);
	const tagRows = selectTagsByLocation.all(locationId);

	const tagsByFood = new Map<string, Tag[]>();
	for (const row of tagRows) {
		const list = tagsByFood.get(row.food_id) ?? [];
		list.push({ id: row.id, label: row.label });
		tagsByFood.set(row.food_id, list);
	}

	return rows.map((row) => ({ ...row, tags: tagsByFood.get(row.id) ?? [] }));
}

export function insertLocation(loc: Omit<Location, 'id'> & { id?: string }): string {
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
	return id;
}

export function insertFood(
	item: Omit<Food, 'id' | 'tags' | 'description'> & {
		id?: string;
		description?: string | null;
		tags?: TagId[];
	}
): string {
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
	return id;
}
