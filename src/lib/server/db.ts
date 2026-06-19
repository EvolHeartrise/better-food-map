/// <reference types="bun-types" />
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types (STABLE CONTRACT — other agents depend on these exact names)
// ---------------------------------------------------------------------------

export type Category = 'cafe' | 'fast_food' | 'restaurant';

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
	ingredients: string | null;
	price: number | null;
}

export interface LocationWithMenu extends Location {
	menu: Food[];
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
		ingredients TEXT,
		price REAL
	);

	CREATE INDEX IF NOT EXISTS idx_food_location_id ON food (location_id);
`);

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

const selectFoodByLocation = db.query<Food, [string]>(
	`SELECT id, location_id, item_name, ingredients, price
	 FROM food
	 WHERE location_id = ?
	 ORDER BY item_name`
);

const insertLocationStmt = db.query<
	unknown,
	[string, string, string | null, number, number, string | null, string | null, string | null]
>(
	`INSERT INTO locations (id, name, category, latitude, longitude, address, phone, website)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertFoodStmt = db.query<unknown, [string, string, string, string | null, number | null]>(
	`INSERT INTO food (id, location_id, item_name, ingredients, price)
	 VALUES (?, ?, ?, ?, ?)`
);

// ---------------------------------------------------------------------------
// Public API (STABLE CONTRACT)
// ---------------------------------------------------------------------------

export function getAllLocations(): Location[] {
	return selectAllLocations.all();
}

export function getLocationById(id: string): Location | null {
	return selectLocationById.get(id) ?? null;
}

export function getFoodByLocation(locationId: string): Food[] {
	return selectFoodByLocation.all(locationId);
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

export function insertFood(item: Omit<Food, 'id'> & { id?: string }): string {
	const id = item.id ?? crypto.randomUUID();
	insertFoodStmt.run(id, item.location_id, item.item_name, item.ingredients, item.price);
	return id;
}
