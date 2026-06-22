/// <reference types="bun-types" />
/**
 * Model Context Protocol server for the food-map database.
 *
 * Exposes CRUD tools over the production Cloudflare D1 database (via the D1 REST
 * API, see src/lib/server/d1-http.ts) so an MCP client (e.g. Claude Code) can
 * read and mutate locations and menu items directly via tool calls. Edits go
 * straight to the same database the deployed site reads from.
 *
 * Requires D1 credentials in .env (see .env.example): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_DATABASE_ID, CLOUDFLARE_API_TOKEN. Bun auto-loads .env.
 *
 * Transport is stdio, so it MUST keep stdout clean for the protocol: all
 * diagnostics go to stderr (never `console.log`).
 *
 * Registered in `.mcp.json`; run standalone with:  bun run db:mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool
} from '@modelcontextprotocol/sdk/types.js';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';

import {
	getLocationsWithTags,
	getLocationById,
	getFoodByLocation,
	getFoodById,
	getAllTags,
	insertLocations,
	insertFoods,
	updateLocation,
	deleteLocation,
	updateFood,
	deleteFood,
	getBrands,
	getBrandById,
	insertBrand,
	updateBrand,
	deleteBrand,
	getMenus,
	getMenuById,
	getMenuWithItems,
	insertMenu,
	updateMenu,
	deleteMenu,
	getMenuItemById,
	insertMenuItems,
	updateMenuItem,
	deleteMenuItem,
	getLocationItemOverrides,
	setLocationItemOverride,
	deleteLocationItemOverride,
	TAGS,
	type D1Like
} from '../src/lib/server/db';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { searchPoi } from './osm/search-poi';
import { OsmPoiStore } from './osm/poi-store';

// The D1 client is created lazily so the server can start and advertise its
// tools even before credentials are configured; the first tool call that needs
// the database surfaces any missing-env error.
let _db: D1Like | undefined;
function getDb(): D1Like {
	return (_db ??= createHttpD1());
}

// The local OSM POI staging store (built by `bun run osm:extract`) is likewise
// opened lazily and read-only; a missing store surfaces a clear error only when
// search_poi is actually called.
let _osmStore: OsmPoiStore | undefined;
function getOsmStore(): OsmPoiStore {
	return (_osmStore ??= OsmPoiStore.openReadonly(process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite'));
}

// ---------------------------------------------------------------------------
// Shared field schemas (valibot — single source of truth for both validation
// and the JSON Schema advertised to the client)
// ---------------------------------------------------------------------------

const categorySchema = v.picklist(['cafe', 'fast_food', 'restaurant', 'bakery']);
const tagIdSchema = v.picklist(TAGS.map((t) => t.id) as [string, ...string[]]);

// Tag ids grouped by kind, derived from the canonical list so the descriptions
// below stay in sync automatically as tags are added.
const dietaryTagIds = TAGS.filter((t) => t.kind === 'dietary').map((t) => t.id);
const courseTagIds = TAGS.filter((t) => t.kind === 'course').map((t) => t.id);

// The single source of truth for how tags are applied. Advertised to MCP clients
// via the server `instructions`, and reused verbatim in every tag-bearing tool
// description so the rule lives in exactly one place.
const TAG_POLICY =
	`Dietary tags (${dietaryTagIds.join(', ')}) are SOURCE-ASSERTED: apply one only when the source ` +
	`explicitly designates the item — via a dietary marker/label/section heading, or when the item's ` +
	`name as shown in the source contains the designation (e.g. "Vegan Burger", "Halal Chicken", ` +
	`"Vegetarian Thali"). Never infer a dietary tag from the ingredient list or general knowledge of ` +
	`the dish; when unsure, omit it. Course tags (${courseTagIds.join(', ')}) describe what kind of ` +
	`item it is and are applied factually (a dessert gets "dessert", a beverage gets "drink").`;

// How the two ways of storing a menu relate. Kept terse and advertised to
// clients so an agent picks the right create_* tool for the situation.
const MODEL_OVERVIEW =
	'Data model — two kinds of menu:\n' +
	'• INDEPENDENT venue: store its menu as `food` rows tied to that one location ' +
	'(create_foods / list_food / update_food / delete_food).\n' +
	"• CHAIN (McDonald's, Subway, …): create a `brand`, then one `menu` per region " +
	'(e.g. "Subway UK"), then the menu\'s shared items once with create_menu_items. ' +
	'Point each branch at that menu by setting its `menu_id` (and `brand_id`) via ' +
	"create_locations/update_location — every such location then serves the menu's " +
	'items automatically, with no per-location copies. Where one branch differs ' +
	'(item sold out, regional price), record just that delta with ' +
	'set_location_item_override. Edit a chain item once with update_menu_item and it ' +
	'changes for every branch.\n' +
	'Rule of thumb: shared across branches → menu_items; unique to one place → food.';

const SERVER_INSTRUCTIONS =
	'CRUD tools over the food-map database (locations, chains/brands, and their menu items). Each ' +
	'location, menu, and item may carry source URLs documenting where the data came from — include ' +
	'them whenever you add scraped data so it stays verifiable.\n\n' +
	'To find venues still missing from the map, use search_poi: it reads a local OpenStreetMap ' +
	'food-POI staging store (built offline, not the live D1), already de-duplicated against existing ' +
	'locations, and returns candidates with an osm_url to cite as the source — then add each with ' +
	`create_locations.\n\n${MODEL_OVERVIEW}\n\nTag policy: ${TAG_POLICY}`;

const latitudeSchema = v.pipe(v.number(), v.minValue(-90), v.maxValue(90));
const longitudeSchema = v.pipe(v.number(), v.minValue(-180), v.maxValue(180));
const priceSchema = v.pipe(v.number(), v.minValue(0));

// A single citation: a URL the data came from, plus an optional human label.
const sourceSchema = v.object({
	url: v.pipe(
		v.string(),
		v.url('Each source must be a valid URL, e.g. https://example.com/menu.'),
		v.description('URL the data was obtained from.')
	),
	label: v.optional(
		v.nullable(
			v.pipe(v.string(), v.description("Optional human-readable label, e.g. 'Official menu'."))
		)
	)
});

// Reused on create_* (append) and update_* (replace wholesale). The wording
// nudges the scraping agent to cite where any added data came from.
const createSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceSchema),
		v.description(
			'Source URLs documenting where this data came from (each: a url and optional label). ' +
				'Strongly encouraged whenever you add scraped data, so it stays verifiable. ' +
				'May be omitted or [] when you genuinely have no source.'
		)
	)
);

const updateSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceSchema),
		v.description(
			'Replaces the full source set (each: a url and optional label). Pass [] to clear all sources. ' +
				'Encouraged: keep at least one source documenting where the data came from.'
		)
	)
);

const idArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('The record id (UUID).'))
});

const createLocationArgs = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.description('Display name of the place.')),
	category: v.optional(
		v.nullable(
			v.pipe(categorySchema, v.description('One of: cafe, fast_food, restaurant, bakery.'))
		)
	),
	latitude: v.pipe(latitudeSchema, v.description('Latitude in decimal degrees.')),
	longitude: v.pipe(longitudeSchema, v.description('Longitude in decimal degrees.')),
	address: v.optional(v.nullable(v.string())),
	phone: v.optional(v.nullable(v.string())),
	website: v.optional(v.nullable(v.string())),
	brand_id: v.optional(
		v.nullable(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description('Chain this branch belongs to (omit for an independent venue).')
			)
		)
	),
	menu_id: v.optional(
		v.nullable(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					'Shared brand menu this branch serves; its items then appear here automatically. ' +
						'Leave unset for an independent venue (use create_foods for its own menu).'
				)
			)
		)
	),
	sources: createSourcesSchema,
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Optional explicit id; a UUID is generated when omitted.')
		)
	)
});

const createLocationsArgs = v.object({
	items: v.pipe(
		v.array(createLocationArgs),
		v.minLength(1),
		v.maxLength(100),
		v.description(
			'Locations to create in one atomic batch (all-or-nothing). Pass a single item to add one place. ' +
				'Ideal for bulk imports such as backfilling a chain across a region — set the same brand_id and ' +
				'menu_id on every item so each branch serves the shared menu, and cite each source (e.g. the ' +
				'osm_url from search_poi). Keep batches to ~50 items.'
		)
	)
});

const updateLocationArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the location to update.')),
	name: v.optional(v.pipe(v.string(), v.minLength(1))),
	category: v.optional(v.nullable(categorySchema)),
	latitude: v.optional(latitudeSchema),
	longitude: v.optional(longitudeSchema),
	address: v.optional(v.nullable(v.string())),
	phone: v.optional(v.nullable(v.string())),
	website: v.optional(v.nullable(v.string())),
	brand_id: v.optional(
		v.nullable(
			v.pipe(v.string(), v.minLength(1), v.description('Reassign to a chain; null detaches it.'))
		)
	),
	menu_id: v.optional(
		v.nullable(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description('Assign/replace the shared menu this branch serves; null detaches it.')
			)
		)
	),
	sources: updateSourcesSchema
});

// One menu item within a create_foods batch. location_id is given once for the
// whole batch, so it isn't repeated per item.
const foodItemSchema = v.object({
	item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(v.nullable(v.string())),
	price: v.optional(v.nullable(v.pipe(priceSchema, v.description('Price in CAD.')))),
	tags: v.optional(
		v.pipe(v.array(tagIdSchema), v.description('Tags to apply to this item. ' + TAG_POLICY))
	),
	sources: createSourcesSchema,
	id: v.optional(v.pipe(v.string(), v.minLength(1)))
});

const createFoodsArgs = v.object({
	location_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Id of the location every item in this batch belongs to.')
	),
	items: v.pipe(
		v.array(foodItemSchema),
		v.minLength(1),
		v.description(
			'The menu items to create under the location, inserted atomically (all-or-nothing).'
		)
	)
});

const updateFoodArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the menu item to update.')),
	location_id: v.optional(v.pipe(v.string(), v.minLength(1))),
	item_name: v.optional(v.pipe(v.string(), v.minLength(1))),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(v.nullable(v.string())),
	price: v.optional(v.nullable(priceSchema)),
	tags: v.optional(
		v.pipe(
			v.array(tagIdSchema),
			v.description('Replaces the full tag set for this item (pass [] to clear). ' + TAG_POLICY)
		)
	),
	sources: updateSourcesSchema
});

const listFoodArgs = v.object({
	location_id: v.pipe(v.string(), v.minLength(1), v.description('Location whose menu to list.'))
});

const nearSchema = v.object({
	latitude: v.pipe(latitudeSchema, v.description('Centre latitude in decimal degrees.')),
	longitude: v.pipe(longitudeSchema, v.description('Centre longitude in decimal degrees.')),
	radius_km: v.pipe(v.number(), v.minValue(0), v.description('Radius in kilometres.'))
});

const listLocationsArgs = v.object({
	near: v.optional(
		v.pipe(
			nearSchema,
			v.description('Only return locations within radius_km of this point, ordered nearest first.')
		)
	),
	category: v.optional(
		v.pipe(categorySchema, v.description('Only return locations in this category.'))
	),
	limit: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Maximum number to return.'))
	),
	offset: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(0),
			v.description('Skip this many results (paging).')
		)
	)
});

const querySqlArgs = v.object({
	sql: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('A single read-only SQL statement (must start with SELECT or WITH).')
	)
});

// --- OSM POI discovery (reads the local staging store, not D1) ---

const bboxSchema = v.object({
	min_lat: latitudeSchema,
	min_lon: longitudeSchema,
	max_lat: latitudeSchema,
	max_lon: longitudeSchema
});

const searchPoiArgs = v.object({
	latitude: v.optional(
		v.pipe(latitudeSchema, v.description('Centre latitude (with longitude + radius_km).'))
	),
	longitude: v.optional(
		v.pipe(longitudeSchema, v.description('Centre longitude (with latitude + radius_km).'))
	),
	radius_km: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(50),
			v.description('Search radius in km around the centre (max 50).')
		)
	),
	bbox: v.optional(
		v.pipe(
			bboxSchema,
			v.description('Bounding box to search. Provide this OR latitude+longitude+radius_km.')
		)
	),
	category: v.optional(
		v.pipe(categorySchema, v.description('Only POIs whose suggested category is this.'))
	),
	name: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Case-insensitive substring match on the POI name.')
		)
	),
	cuisine: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Case-insensitive substring match on the OSM cuisine tag.')
		)
	),
	exclude_existing: v.optional(
		v.pipe(v.boolean(), v.description('Omit POIs already present in the database (default true).'))
	),
	limit: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(200),
			v.description('Maximum candidates to return (default 50, max 200).')
		)
	)
});

// --- Chains: brands, menus, menu items, per-location overrides ---

const createBrandArgs = v.object({
	name: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Chain / brand name, e.g. "McDonald\'s".')
	),
	website: v.optional(v.nullable(v.string())),
	logo_url: v.optional(
		v.nullable(v.pipe(v.string(), v.url(), v.description('URL of the brand logo/marker image.')))
	),
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Optional explicit id; a UUID is generated when omitted.')
		)
	)
});

const updateBrandArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the brand to update.')),
	name: v.optional(v.pipe(v.string(), v.minLength(1))),
	website: v.optional(v.nullable(v.string())),
	logo_url: v.optional(v.nullable(v.pipe(v.string(), v.url())))
});

const createMenuArgs = v.object({
	brand_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Id of the brand this menu belongs to.')
	),
	name: v.pipe(v.string(), v.minLength(1), v.description('Menu name, e.g. "Subway UK".')),
	region: v.optional(
		v.nullable(
			v.pipe(v.string(), v.description('Free-form scope label, e.g. "GB", "US-CA", "Canada".'))
		)
	),
	last_verified: v.optional(
		v.nullable(
			v.pipe(v.string(), v.description('ISO date this menu was last checked, e.g. "2026-06-22".'))
		)
	),
	sources: createSourcesSchema,
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Optional explicit id; a UUID is generated when omitted.')
		)
	)
});

const updateMenuArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the menu to update.')),
	brand_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
	name: v.optional(v.pipe(v.string(), v.minLength(1))),
	region: v.optional(v.nullable(v.string())),
	last_verified: v.optional(v.nullable(v.string())),
	sources: updateSourcesSchema
});

const listMenusArgs = v.object({
	brand_id: v.optional(
		v.pipe(v.string(), v.minLength(1), v.description('Only list menus belonging to this brand.'))
	)
});

// One shared menu item within a create_menu_items batch. menu_id is given once
// for the whole batch, so it isn't repeated per item.
const menuItemSchema = v.object({
	item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(v.nullable(v.string())),
	price: v.optional(
		v.nullable(
			v.pipe(priceSchema, v.description('Default price; a branch can override it per-location.'))
		)
	),
	tags: v.optional(
		v.pipe(v.array(tagIdSchema), v.description('Tags to apply to this item. ' + TAG_POLICY))
	),
	sources: createSourcesSchema,
	id: v.optional(v.pipe(v.string(), v.minLength(1)))
});

const createMenuItemsArgs = v.object({
	menu_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Id of the menu every item in this batch belongs to.')
	),
	items: v.pipe(
		v.array(menuItemSchema),
		v.minLength(1),
		v.description('The shared menu items to create, inserted atomically (all-or-nothing).')
	)
});

const updateMenuItemArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the menu item to update.')),
	menu_id: v.optional(v.pipe(v.string(), v.minLength(1))),
	item_name: v.optional(v.pipe(v.string(), v.minLength(1))),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(v.nullable(v.string())),
	price: v.optional(v.nullable(priceSchema)),
	tags: v.optional(
		v.pipe(
			v.array(tagIdSchema),
			v.description('Replaces the full tag set for this item (pass [] to clear). ' + TAG_POLICY)
		)
	),
	sources: updateSourcesSchema
});

const setOverrideArgs = v.object({
	location_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Branch that deviates from its shared menu.')
	),
	menu_item_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Shared menu item being overridden at this branch.')
	),
	available: v.optional(
		v.nullable(
			v.pipe(
				v.boolean(),
				v.description('false = not served at this branch; null = inherit (served).')
			)
		)
	),
	price: v.optional(
		v.nullable(
			v.pipe(priceSchema, v.description('Price at this branch; null = inherit the menu price.'))
		)
	)
});

const deleteOverrideArgs = v.object({
	location_id: v.pipe(v.string(), v.minLength(1), v.description('Branch the override is on.')),
	menu_item_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Shared menu item to un-override.')
	)
});

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

type AnySchema = v.GenericSchema;

interface ToolDef<S extends AnySchema> {
	name: string;
	description: string;
	schema: S;
	handler: (input: v.InferOutput<S>) => unknown;
}

function defineTool<S extends AnySchema>(def: ToolDef<S>): ToolDef<S> {
	return def;
}

/** Normalizes optional source labels to null so they match the DB `Source` type. */
function normalizeSources(
	sources: { url: string; label?: string | null }[] | undefined
): { url: string; label: string | null }[] | undefined {
	return sources?.map((s) => ({ url: s.url, label: s.label ?? null }));
}

/**
 * Validates that any referenced brand/menu exists (and, when both are given,
 * that the menu belongs to that brand) before linking a location to them.
 * `null`/`undefined` ids are skipped (detaching is always allowed).
 */
async function assertBrandMenuRefs(
	brandId: string | null | undefined,
	menuId: string | null | undefined
): Promise<void> {
	if (brandId) {
		if (!(await getBrandById(getDb(), brandId))) throw new Error(`No brand with id "${brandId}".`);
	}
	if (menuId) {
		const menu = await getMenuById(getDb(), menuId);
		if (!menu) throw new Error(`No menu with id "${menuId}".`);
		if (brandId && menu.brand_id && menu.brand_id !== brandId) {
			throw new Error(
				`Menu "${menuId}" belongs to brand "${menu.brand_id}", not "${brandId}". ` +
					`Pass a matching brand_id or omit it.`
			);
		}
	}
}

/** Great-circle distance between two lat/long points, in kilometres. */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const R = 6371;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(bLat - aLat);
	const dLon = toRad(bLon - aLon);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** Read-only guard for the raw SQL escape hatch. */
async function runReadOnlySql(sql: string): Promise<unknown> {
	const trimmed = sql
		.trim()
		.replace(/;+\s*$/, '')
		.trim();
	if (/;/.test(trimmed)) {
		throw new Error('Only a single statement is allowed (no semicolons).');
	}
	if (!/^(select|with)\b/i.test(trimmed)) {
		throw new Error('Only read-only queries are allowed (must start with SELECT or WITH).');
	}
	const { results } = await getDb().prepare(trimmed).all();
	return results;
}

const tools = [
	defineTool({
		name: 'list_locations',
		description:
			'List locations as a lightweight overview — id, name, category, coordinates, address, phone, ' +
			'website, brand_id/menu_id (set for chain branches), and the distinct tag ids offered across the ' +
			'effective menu (no per-item detail, no source URLs). ' +
			'Supports optional `near`/`category` filtering and `limit`/`offset` paging. Use get_location for ' +
			'a single place with its menu and sources.',
		schema: listLocationsArgs,
		handler: async ({ near, category, limit, offset }) => {
			let rows = await getLocationsWithTags(getDb());
			if (category) rows = rows.filter((r) => r.category === category);
			if (near) {
				rows = rows
					.map((r) => ({
						r,
						d: haversineKm(near.latitude, near.longitude, r.latitude, r.longitude)
					}))
					.filter((x) => x.d <= near.radius_km)
					.toSorted((a, b) => a.d - b.d)
					.map((x) => x.r);
			}
			const start = offset ?? 0;
			const page = rows.slice(start, limit === undefined ? undefined : start + limit);
			return page.map((loc) => ({
				id: loc.id,
				name: loc.name,
				category: loc.category,
				latitude: loc.latitude,
				longitude: loc.longitude,
				address: loc.address,
				phone: loc.phone,
				website: loc.website,
				brand_id: loc.brand_id,
				menu_id: loc.menu_id,
				tags: loc.tags.map((t) => t.id)
			}));
		}
	}),
	defineTool({
		name: 'get_location',
		description:
			'Get a single location with its source URLs. `menu` lists only the items owned directly by this ' +
			'location (its `food` rows). If `menu_id` is set the branch ALSO serves that shared brand menu — ' +
			"call get_menu to see/edit those items; `overrides` lists this branch's per-item deviations from " +
			'them. Returns null if not found.',
		schema: idArgs,
		handler: async ({ id }) => {
			const location = await getLocationById(getDb(), id);
			if (!location) return null;
			const [menu, overrides] = await Promise.all([
				getFoodByLocation(getDb(), id),
				getLocationItemOverrides(getDb(), id)
			]);
			return { ...location, menu, overrides };
		}
	}),
	defineTool({
		name: 'create_locations',
		description:
			'Create one or more locations in a single atomic batch (all-or-nothing) — the only way to add ' +
			'locations; pass a one-item `items` array to add a single place. For a chain branch, set ' +
			'`menu_id` (and `brand_id`) on the item so it serves that shared menu; for an independent venue ' +
			'omit them and add its menu with create_foods. Cite each source (encouraged), e.g. the osm_url ' +
			'from search_poi. Ideal for bulk imports like backfilling a chain across a region. If any item ' +
			'is invalid, nothing is written. Returns { created, location_ids } — fetch details with ' +
			'get_location if needed.',
		schema: createLocationsArgs,
		handler: async ({ items }) => {
			// Validate each DISTINCT brand/menu pair once — a chain backfill reuses a
			// single pair across the whole batch, so this is usually one check.
			const checkedPairs = new Set<string>();
			for (const it of items) {
				const key = `${it.brand_id ?? ''}|${it.menu_id ?? ''}`;
				if (checkedPairs.has(key)) continue;
				checkedPairs.add(key);
				await assertBrandMenuRefs(it.brand_id, it.menu_id);
			}
			const ids = await insertLocations(
				getDb(),
				items.map((it) => ({
					id: it.id,
					name: it.name,
					category: it.category ?? null,
					latitude: it.latitude,
					longitude: it.longitude,
					address: it.address ?? null,
					phone: it.phone ?? null,
					website: it.website ?? null,
					brand_id: it.brand_id ?? null,
					menu_id: it.menu_id ?? null,
					sources: normalizeSources(it.sources)
				}))
			);
			return { created: ids.length, location_ids: ids };
		}
	}),
	defineTool({
		name: 'update_location',
		description:
			'Update one or more fields of an existing location. Only provided fields change; if `sources` is ' +
			'given it replaces the whole source set (pass [] to clear). Set `menu_id`/`brand_id` to attach the ' +
			'branch to a chain menu, or null to detach it. Returns the updated row, or null if the id does not exist.',
		schema: updateLocationArgs,
		handler: async ({ id, sources, ...patch }) => {
			await assertBrandMenuRefs(patch.brand_id, patch.menu_id);
			return updateLocation(getDb(), id, { ...patch, sources: normalizeSources(sources) });
		}
	}),
	defineTool({
		name: 'delete_location',
		description:
			'Delete a location and (by cascade) all of its menu items. Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteLocation(getDb(), id) })
	}),
	defineTool({
		name: 'list_food',
		description:
			"List a location's own `food` items (with tags and sources). Shared chain-menu items are " +
			'not included here — read those via get_menu.',
		schema: listFoodArgs,
		handler: async ({ location_id }) => getFoodByLocation(getDb(), location_id)
	}),
	defineTool({
		name: 'get_food',
		description:
			"Get one of a location's own `food` items with its dietary tags and source URLs (for a shared " +
			'chain-menu item use get_menu_item). Returns null if not found.',
		schema: idArgs,
		handler: async ({ id }) => getFoodById(getDb(), id)
	}),
	defineTool({
		name: 'create_foods',
		description:
			'Create one or more menu items owned by ONE independent location (its own `food` rows), in a ' +
			'single transaction (all-or-nothing): ' +
			"if any item is invalid, none are written. Use this for a venue's own menu; for a chain whose branches share a menu, use create_menu_items instead. Pass a" +
			'one-element `items` array to add a single item. Returns the created items (each with tags and sources).',
		schema: createFoodsArgs,
		handler: async (input) => {
			if (!(await getLocationById(getDb(), input.location_id))) {
				throw new Error(`No location with id "${input.location_id}".`);
			}
			const ids = await insertFoods(
				getDb(),
				input.items.map((it) => ({
					id: it.id,
					location_id: input.location_id,
					item_name: it.item_name,
					description: it.description ?? null,
					ingredients: it.ingredients ?? null,
					price: it.price ?? null,
					tags: it.tags,
					sources: normalizeSources(it.sources)
				}))
			);
			return Promise.all(ids.map((id) => getFoodById(getDb(), id)));
		}
	}),
	defineTool({
		name: 'update_food',
		description:
			"Update one of a location's own `food` items (for shared chain items, use update_menu_item). " +
			'Only provided fields change; if `tags` or `sources` is given it replaces that whole set (pass [] to clear). Returns the updated item, or null if the id does not exist.',
		schema: updateFoodArgs,
		handler: async ({ id, sources, ...patch }) =>
			updateFood(getDb(), id, { ...patch, sources: normalizeSources(sources) })
	}),
	defineTool({
		name: 'delete_food',
		description: 'Delete a single menu item. Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteFood(getDb(), id) })
	}),
	defineTool({
		name: 'list_tags',
		description:
			'List the canonical, app-defined tags, each with a kind (dietary or course). These are fixed and cannot be created via this server.',
		schema: v.object({}),
		handler: () => getAllTags()
	}),
	defineTool({
		name: 'query_sql',
		description:
			'Run a single read-only SQL query (SELECT/WITH only) against the database for ad-hoc inspection. Returns the result rows.',
		schema: querySqlArgs,
		handler: ({ sql }) => runReadOnlySql(sql)
	})
] as const;

// Chain tools: brands → menus → shared menu items, plus per-location overrides.
// Kept in a separate array purely for grouping; merged into `allTools` below.
const chainTools = [
	defineTool({
		name: 'create_brand',
		description:
			"Create a chain/brand (e.g. McDonald's). A brand owns one or more regional menus (create_menu); " +
			'a location joins the chain by setting its brand_id/menu_id. Returns the created brand.',
		schema: createBrandArgs,
		handler: async (input) => {
			const id = await insertBrand(getDb(), {
				id: input.id,
				name: input.name,
				website: input.website ?? null,
				logo_url: input.logo_url ?? null
			});
			return getBrandById(getDb(), id);
		}
	}),
	defineTool({
		name: 'list_brands',
		description:
			'List all chains/brands (id, name, website, logo_url). Use get_brand for one brand with its menus.',
		schema: v.object({}),
		handler: () => getBrands(getDb())
	}),
	defineTool({
		name: 'get_brand',
		description:
			'Get a brand plus its menus as summaries (id, name, region, last_verified, item_count). Call ' +
			"get_menu for a menu's items. Returns null if not found.",
		schema: idArgs,
		handler: async ({ id }) => {
			const brand = await getBrandById(getDb(), id);
			if (!brand) return null;
			return { ...brand, menus: await getMenus(getDb(), id) };
		}
	}),
	defineTool({
		name: 'update_brand',
		description:
			'Update a brand. Only provided fields change. Returns the updated brand, or null if the id does not exist.',
		schema: updateBrandArgs,
		handler: ({ id, ...patch }) => updateBrand(getDb(), id, patch)
	}),
	defineTool({
		name: 'delete_brand',
		description:
			'Delete a brand and (by cascade) its menus and their items. Branches that referenced it revert to ' +
			'independent (brand_id/menu_id cleared). Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteBrand(getDb(), id) })
	}),
	defineTool({
		name: 'create_menu',
		description:
			'Create a regional menu under a brand (e.g. name "Subway UK", region "GB"). Add its shared items ' +
			'with create_menu_items, then point each branch at it via location.menu_id. Optionally cite the ' +
			'official menu once via `sources`. Returns the created menu.',
		schema: createMenuArgs,
		handler: async (input) => {
			if (!(await getBrandById(getDb(), input.brand_id))) {
				throw new Error(`No brand with id "${input.brand_id}".`);
			}
			const id = await insertMenu(getDb(), {
				id: input.id,
				brand_id: input.brand_id,
				name: input.name,
				region: input.region ?? null,
				last_verified: input.last_verified ?? null,
				sources: normalizeSources(input.sources)
			});
			return getMenuById(getDb(), id);
		}
	}),
	defineTool({
		name: 'list_menus',
		description:
			'List menus (id, brand_id, name, region, last_verified, item_count), optionally filtered to one ' +
			"brand. Use get_menu for a menu's items.",
		schema: listMenusArgs,
		handler: ({ brand_id }) => getMenus(getDb(), brand_id)
	}),
	defineTool({
		name: 'get_menu',
		description:
			"Get a menu with its full item list (each item carries its tags and sources) and the menu's own " +
			'source URLs. Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => getMenuWithItems(getDb(), id)
	}),
	defineTool({
		name: 'update_menu',
		description:
			'Update a menu. Only provided fields change; if `sources` is given it replaces the whole source set ' +
			'(pass [] to clear). Returns the updated menu, or null if the id does not exist.',
		schema: updateMenuArgs,
		handler: async ({ id, sources, ...patch }) => {
			if (patch.brand_id && !(await getBrandById(getDb(), patch.brand_id))) {
				throw new Error(`No brand with id "${patch.brand_id}".`);
			}
			return updateMenu(getDb(), id, { ...patch, sources: normalizeSources(sources) });
		}
	}),
	defineTool({
		name: 'delete_menu',
		description:
			'Delete a menu and (by cascade) its items. Branches serving it revert to independent (menu_id ' +
			'cleared). Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteMenu(getDb(), id) })
	}),
	defineTool({
		name: 'create_menu_items',
		description:
			'Create one or more SHARED items on a brand menu in one transaction (all-or-nothing). Defined once ' +
			'here, they appear at every branch serving this menu — never copy them per location. For an ' +
			"independent venue's own menu use create_foods instead. Returns the created items.",
		schema: createMenuItemsArgs,
		handler: async (input) => {
			if (!(await getMenuById(getDb(), input.menu_id))) {
				throw new Error(`No menu with id "${input.menu_id}".`);
			}
			const ids = await insertMenuItems(
				getDb(),
				input.items.map((it) => ({
					id: it.id,
					menu_id: input.menu_id,
					item_name: it.item_name,
					description: it.description ?? null,
					ingredients: it.ingredients ?? null,
					price: it.price ?? null,
					tags: it.tags,
					sources: normalizeSources(it.sources)
				}))
			);
			return Promise.all(ids.map((id) => getMenuItemById(getDb(), id)));
		}
	}),
	defineTool({
		name: 'get_menu_item',
		description:
			'Get a single shared menu item with its dietary tags and source URLs. Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => getMenuItemById(getDb(), id)
	}),
	defineTool({
		name: 'update_menu_item',
		description:
			'Update a shared menu item — the change applies to EVERY branch serving its menu. Only provided ' +
			'fields change; if `tags`/`sources` is given it replaces that whole set (pass [] to clear). To ' +
			'change just one branch, use set_location_item_override instead. Returns the updated item, or null ' +
			'if the id does not exist.',
		schema: updateMenuItemArgs,
		handler: async ({ id, sources, ...patch }) =>
			updateMenuItem(getDb(), id, { ...patch, sources: normalizeSources(sources) })
	}),
	defineTool({
		name: 'delete_menu_item',
		description:
			'Delete a shared menu item (removed from every branch serving its menu, plus any per-location ' +
			'overrides of it). Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteMenuItem(getDb(), id) })
	}),
	defineTool({
		name: 'set_location_item_override',
		description:
			'Record how ONE branch differs from its shared menu for ONE item: available=false hides the item ' +
			'at that branch; price overrides it there. Pass null for either to inherit the menu default. ' +
			'Creates or replaces the override. Prefer this over editing the shared item when only one branch differs.',
		schema: setOverrideArgs,
		handler: async ({ location_id, menu_item_id, available, price }) => {
			await setLocationItemOverride(getDb(), location_id, menu_item_id, { available, price });
			return { location_id, menu_item_id, available: available ?? null, price: price ?? null };
		}
	}),
	defineTool({
		name: 'delete_location_item_override',
		description:
			"Remove a branch's override of a shared menu item, so it inherits the menu default again. Returns " +
			'{ deleted: true } if an override was removed.',
		schema: deleteOverrideArgs,
		handler: async ({ location_id, menu_item_id }) => ({
			deleted: await deleteLocationItemOverride(getDb(), location_id, menu_item_id)
		})
	})
] as const;

// OSM discovery tool: reads the local food-POI staging store (built by
// `bun run osm:extract`) so an agent can find venues still missing from the map.
const osmTools = [
	defineTool({
		name: 'search_poi',
		description:
			'Find OpenStreetMap food venues to add to the map, from the LOCAL OSM staging store ' +
			'(built offline via `bun run osm:extract`; not the live D1). Give either a centre ' +
			'(latitude + longitude + radius_km) or a `bbox`. By default it omits venues already in ' +
			'the database (set exclude_existing=false to see all), so you get only what is still ' +
			'missing — ordered nearest-first for centre+radius queries. Each candidate includes an ' +
			'`osm_url` to cite as the source, a `suggested_category` (cafe/fast_food/restaurant/bakery, ' +
			'or null for bars/pubs/ice_cream/food_court — pick the best fit), and OSM ' +
			'address/phone/website/cuisine/opening_hours where tagged. `diet_markers` are venue-level ' +
			'OSM diet:* markers (informational only — still apply per-item dietary tags per the ' +
			'source-asserted policy). Workflow: call this, then create_locations, passing each ' +
			'osm_url in `sources`.',
		schema: searchPoiArgs,
		handler: async (input) => {
			const db = input.exclude_existing === false ? null : getDb();
			return searchPoi(getOsmStore(), db, {
				bbox: input.bbox
					? {
							minLat: input.bbox.min_lat,
							minLon: input.bbox.min_lon,
							maxLat: input.bbox.max_lat,
							maxLon: input.bbox.max_lon
						}
					: undefined,
				latitude: input.latitude,
				longitude: input.longitude,
				radius_km: input.radius_km,
				category: input.category,
				name: input.name,
				cuisine: input.cuisine,
				exclude_existing: input.exclude_existing,
				limit: input.limit
			});
		}
	})
] as const;

const allTools = [...tools, ...chainTools, ...osmTools];

const toolsByName = new Map(allTools.map((t) => [t.name, t] as const));

/** valibot → JSON Schema for the MCP `inputSchema` field. */
function inputSchemaFor(schema: AnySchema): Tool['inputSchema'] {
	const json = toJsonSchema(schema) as Record<string, unknown>;
	delete json.$schema;
	return json as Tool['inputSchema'];
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
	{ name: 'better-food-map-db', version: '0.0.1' },
	{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: allTools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: inputSchemaFor(t.schema)
	}))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: rawArgs } = request.params;
	const tool = toolsByName.get(name);
	if (!tool) {
		return {
			content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
			isError: true
		};
	}

	try {
		const input = v.parse(tool.schema, rawArgs ?? {});
		const result = await tool.handler(input as never);
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
		};
	} catch (err) {
		const message =
			err instanceof v.ValiError
				? `Invalid arguments: ${err.issues.map((i) => `${i.path?.map((p) => p.key).join('.') ?? '(root)'}: ${i.message}`).join('; ')}`
				: err instanceof Error
					? err.message
					: String(err);
		return {
			content: [{ type: 'text' as const, text: message }],
			isError: true
		};
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[better-food-map-db] MCP server ready on stdio');
