/// <reference types="bun-types" />
/**
 * Model Context Protocol server for the Vancouver food-map database.
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
	insertFood,
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

const categorySchema = v.picklist(['cafe', 'fast_food', 'restaurant']);
const tagIdSchema = v.picklist(TAGS.map((t) => t.id) as [string, ...string[]]);

const latitudeSchema = v.pipe(v.number(), v.minValue(-90), v.maxValue(90));
const longitudeSchema = v.pipe(v.number(), v.minValue(-180), v.maxValue(180));
const priceSchema = v.pipe(v.number(), v.minValue(0));

const idArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('The record id (UUID).'))
});

const createLocationArgs = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.description('Display name of the place.')),
	category: v.optional(
		v.nullable(v.pipe(categorySchema, v.description('One of: cafe, fast_food, restaurant.')))
	),
	latitude: v.pipe(latitudeSchema, v.description('Latitude in decimal degrees.')),
	longitude: v.pipe(longitudeSchema, v.description('Longitude in decimal degrees.')),
	address: v.optional(v.nullable(v.string())),
	phone: v.optional(v.nullable(v.string())),
	website: v.optional(v.nullable(v.string())),
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
	website: v.optional(v.nullable(v.string()))
});

const createFoodArgs = v.object({
	location_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Id of the location this item belongs to.')
	),
	item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(v.nullable(v.string())),
	price: v.optional(v.nullable(v.pipe(priceSchema, v.description('Price in CAD.')))),
	tags: v.optional(
		v.pipe(
			v.array(tagIdSchema),
			v.description('Dietary tags: vegan, vegetarian, gluten_free, dairy_free, nut_free, halal.')
		)
	),
	id: v.optional(v.pipe(v.string(), v.minLength(1)))
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
			v.description('Replaces the full tag set. Pass [] to clear all tags.')
		)
	)
});

const listFoodArgs = v.object({
	location_id: v.pipe(v.string(), v.minLength(1), v.description('Location whose menu to list.'))
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
			'List every location with the distinct dietary tags offered across its menu (no individual menu items). Use get_location for a full menu.',
		schema: v.object({}),
		handler: () => getLocationsWithTags()
	}),
	defineTool({
		name: 'get_location',
		description:
			'Get a single location merged with its full menu (each item carries its tags). Returns null if not found.',
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
			'Create a new location. Returns the created location row (including its generated id).',
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
				website: input.website ?? null
			});
			return getLocationById(id);
		}
	}),
	defineTool({
		name: 'update_location',
		description:
			'Update one or more fields of an existing location. Only provided fields change. Returns the updated row, or null if the id does not exist.',
		schema: updateLocationArgs,
		handler: ({ id, ...patch }) => updateLocation(id, patch)
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
		description: 'List all menu items (with tags) for a given location.',
		schema: listFoodArgs,
		handler: ({ location_id }) => getFoodByLocation(location_id)
	}),
	defineTool({
		name: 'get_food',
		description: 'Get a single menu item with its dietary tags. Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => getFoodById(id)
	}),
	defineTool({
		name: 'create_food',
		description:
			'Create a menu item under a location, optionally with dietary tags. Returns the created item (with tags).',
		schema: createFoodArgs,
		handler: (input) => {
			if (!getLocationById(input.location_id)) {
				throw new Error(`No location with id "${input.location_id}".`);
			}
			const id = insertFood({
				id: input.id,
				location_id: input.location_id,
				item_name: input.item_name,
				description: input.description ?? null,
				ingredients: input.ingredients ?? null,
				price: input.price ?? null,
				tags: input.tags
			});
			return getFoodById(id);
		}
	}),
	defineTool({
		name: 'update_food',
		description:
			'Update a menu item. Only provided fields change; if `tags` is given it replaces the whole tag set (pass [] to clear). Returns the updated item, or null if the id does not exist.',
		schema: updateFoodArgs,
		handler: ({ id, ...patch }) => updateFood(id, patch)
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
			'List the canonical, app-defined dietary tags. These are fixed and cannot be created via this server.',
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
	{ capabilities: { tools: {} } }
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
