/// <reference types="bun-types" />
/**
 * Model Context Protocol server for the food-map database.
 *
 * Exposes CRUD tools over `data/food.db` so an MCP client (e.g. Claude Code)
 * can read and mutate locations and menu items directly via tool calls. This is
 * the sole mechanism for populating and editing the database.
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
	db,
	getLocationsWithTags,
	getLocationById,
	getFoodByLocation,
	getFoodById,
	getAllTags,
	insertLocation,
	insertFoods,
	updateLocation,
	deleteLocation,
	updateFood,
	deleteFood,
	TAGS
} from '../src/lib/server/db';

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

const SERVER_INSTRUCTIONS =
	'CRUD tools over the food-map database (locations and their menu items). Each location and item ' +
	'may carry source URLs documenting where the data came from — include them whenever you add ' +
	`scraped data so it stays verifiable.\n\nTag policy: ${TAG_POLICY}`;

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
	sources: createSourcesSchema,
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Optional explicit id; a UUID is generated when omitted.')
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
function runReadOnlySql(sql: string): unknown {
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
	return db.query(trimmed).all();
}

const tools = [
	defineTool({
		name: 'list_locations',
		description:
			'List locations as a lightweight overview — id, name, category, coordinates, address, phone, ' +
			'website, and the distinct tag ids offered across the menu (no per-item detail, no source URLs). ' +
			'Supports optional `near`/`category` filtering and `limit`/`offset` paging. Use get_location for ' +
			'a single place with its full menu and sources.',
		schema: listLocationsArgs,
		handler: ({ near, category, limit, offset }) => {
			let rows = getLocationsWithTags();
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
				tags: loc.tags.map((t) => t.id)
			}));
		}
	}),
	defineTool({
		name: 'get_location',
		description:
			'Get a single location (with its source URLs) merged with its full menu (each item carries its tags and sources). Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => {
			const location = getLocationById(id);
			if (!location) return null;
			return { ...location, menu: getFoodByLocation(id) };
		}
	}),
	defineTool({
		name: 'create_location',
		description:
			'Create a new location, optionally with source URLs documenting where its data came from (encouraged). Returns the created location row (including its generated id and sources).',
		schema: createLocationArgs,
		handler: (input) => {
			const id = insertLocation({
				id: input.id,
				name: input.name,
				category: input.category ?? null,
				latitude: input.latitude,
				longitude: input.longitude,
				address: input.address ?? null,
				phone: input.phone ?? null,
				website: input.website ?? null,
				sources: normalizeSources(input.sources)
			});
			return getLocationById(id);
		}
	}),
	defineTool({
		name: 'update_location',
		description:
			'Update one or more fields of an existing location. Only provided fields change; if `sources` is given it replaces the whole source set (pass [] to clear). Returns the updated row, or null if the id does not exist.',
		schema: updateLocationArgs,
		handler: ({ id, sources, ...patch }) =>
			updateLocation(id, { ...patch, sources: normalizeSources(sources) })
	}),
	defineTool({
		name: 'delete_location',
		description:
			'Delete a location and (by cascade) all of its menu items. Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: ({ id }) => ({ deleted: deleteLocation(id) })
	}),
	defineTool({
		name: 'list_food',
		description: 'List all menu items (with tags and sources) for a given location.',
		schema: listFoodArgs,
		handler: ({ location_id }) => getFoodByLocation(location_id)
	}),
	defineTool({
		name: 'get_food',
		description:
			'Get a single menu item with its dietary tags and source URLs. Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => getFoodById(id)
	}),
	defineTool({
		name: 'create_foods',
		description:
			'Create one or more menu items under a location in a single transaction (all-or-nothing): ' +
			'if any item is invalid, none are written. This is the only way to add menu items — pass a ' +
			'one-element `items` array to add a single item. Returns the created items (each with tags and sources).',
		schema: createFoodsArgs,
		handler: (input) => {
			if (!getLocationById(input.location_id)) {
				throw new Error(`No location with id "${input.location_id}".`);
			}
			const ids = insertFoods(
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
			return ids.map((id) => getFoodById(id));
		}
	}),
	defineTool({
		name: 'update_food',
		description:
			'Update a menu item. Only provided fields change; if `tags` or `sources` is given it replaces that whole set (pass [] to clear). Returns the updated item, or null if the id does not exist.',
		schema: updateFoodArgs,
		handler: ({ id, sources, ...patch }) =>
			updateFood(id, { ...patch, sources: normalizeSources(sources) })
	}),
	defineTool({
		name: 'delete_food',
		description: 'Delete a single menu item. Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: ({ id }) => ({ deleted: deleteFood(id) })
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

const toolsByName = new Map(tools.map((t) => [t.name, t] as const));

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
	tools: tools.map((t) => ({
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
		const result = tool.handler(input as never);
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
