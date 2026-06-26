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
	getItemById,
	updateItem,
	deleteItem,
	getAllTags,
	insertLocations,
	insertFoods,
	updateLocations,
	deleteLocation,
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
	insertMenuItems,
	getLocationItemOverrides,
	setLocationItemOverride,
	deleteLocationItemOverride,
	existingIds,
	searchTagVocabulary,
	TAGS,
	TAG_SEARCH_LIMIT,
	type D1Like,
	type LocationWithTags
} from '../src/lib/server/db';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { normalizeRegion, normalizePostcode, normalizeCountry } from '../src/lib/address';
import { ingredientProseWarning } from '../src/lib/tags';
import { searchPoi } from './osm/search-poi';
import { findCoordinateDrift } from './osm/find-coordinate-drift';
import { findMissingAddress } from './osm/find-missing-address';
import { OsmPoiStore } from './osm/poi-store';
import { osmOwnAddressParts, osmUrl } from './osm/map-feature';
import { bboxAround, haversineMeters } from './osm/geo';

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

// Tag ids grouped by type, derived from the canonical list so the descriptions
// below stay in sync automatically as tags are added.
const dietaryTagIds = TAGS.filter((t) => t.tag_type === 'dietary').map((t) => t.id);
const courseTagIds = TAGS.filter((t) => t.tag_type === 'course').map((t) => t.id);

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

// A one-line pointer to {@link TAG_POLICY} for the many per-field tag descriptions.
// The full policy is advertised once in the server instructions and the item-tool
// descriptions; repeating its ~600 chars on every tag field only bloats the
// advertised JSON Schema, so the fields just restate the load-bearing rule.
const TAG_POLICY_SHORT =
	'Dietary tags are SOURCE-ASSERTED — apply only when the source explicitly designates the item ' +
	'(name or marker), never inferred from ingredients; course tags (dessert/drink) are factual. ' +
	'See the server tag policy.';

// How the two ways of storing a menu relate. Kept terse and advertised to
// clients so an agent picks the right create_* tool for the situation.
const MODEL_OVERVIEW =
	'Data model — every location serves a menu of items:\n' +
	'• INDEPENDENT venue: add its items with create_foods. They live on a private menu created ' +
	'automatically for that one location (browse them via get_location).\n' +
	"• CHAIN (McDonald's, Subway, …): create a `brand`, then one `menu` per region " +
	'(e.g. "Subway UK"), then the menu\'s shared items once with create_menu_items (browse them via ' +
	'get_menu). Point each branch at that menu by setting its `menu_id` (and `brand_id`) via ' +
	"create_locations/update_locations — every such location then serves the menu's " +
	'items automatically, with no per-location copies. Where one branch differs ' +
	'(item sold out, regional price), record just that delta with set_location_item_override.\n' +
	'Once created, read/edit/remove any item by id with get_item / update_item / delete_item ' +
	'(editing a shared chain item changes it for every branch).\n' +
	'Rule of thumb: shared across branches → create_menu_items; unique to one place → create_foods.\n' +
	'Items carry tags and ingredients: pass `ingredients` as a comma-separated string and ' +
	'each part is stored as an ingredient tag. Use `optional_tags` / `optional_ingredients` for ' +
	'things that can be added or left out (e.g. an item that can be made vegan, or cheese on request).';

// The single source of truth for what makes a good authored ingredient tag.
// Advertised in the server instructions and reused (short form) on every
// ingredient-bearing field so the rule lives in exactly one place — mirrors how
// TAG_POLICY is handled for dietary/course tags.
const INGREDIENT_TAG_STANDARD =
	'Ingredient standard: an ingredient is a NOUN naming ONE food component (e.g. "tomato", "cashew", ' +
	'"paneer", "soy sauce", "coconut milk"). Keep them generic and reusable across menus, and ATOMIC — ' +
	'one ingredient per comma-separated part (split "beets & cilantro" into "beets, cilantro"). Do NOT ' +
	'put a dish description, preparation, serving note, price, size or choice list in `ingredients` ' +
	'(no "served with…", "topped with…", "12 oz", "choice of milk") — prose belongs in the item ' +
	'`description`, and dietary/course facts in `tags`. REUSE an existing tag instead of a near-duplicate: ' +
	'call search_tags first. Spellings are auto-canonicalized for you (accents folded; known plurals and ' +
	'synonyms mapped to one canonical tag), but search_tags is still the way to match the established name.';

// One-line pointer to {@link INGREDIENT_TAG_STANDARD} for the per-field ingredient
// descriptions, keeping the advertised JSON Schema lean (the full standard is in the
// server instructions).
const INGREDIENT_STANDARD_SHORT =
	'Each part must be ONE component noun — never a description, price or serving note (those go in ' +
	'`description`). Call search_tags to reuse the canonical tag. See the ingredient standard.';

const SERVER_INSTRUCTIONS =
	'CRUD tools over the food-map database (locations, chains/brands, and their menu items). Each ' +
	'location, menu, and item may carry source URLs documenting where the data came from — include ' +
	'them whenever you add scraped data so it stays verifiable.\n\n' +
	'To find venues still missing from the map, use search_poi: it reads a local OpenStreetMap ' +
	'food-POI staging store (built offline, not the live D1), already de-duplicated against existing ' +
	'locations, and returns candidates each carrying an `osm_id` (pass it to create_locations to import OSM coordinates + address verbatim) — then add each with ' +
	`create_locations.\n\n${MODEL_OVERVIEW}\n\nTag policy: ${TAG_POLICY}\n\n${INGREDIENT_TAG_STANDARD}`;

const latitudeSchema = v.pipe(v.number(), v.minValue(-90), v.maxValue(90));
const longitudeSchema = v.pipe(v.number(), v.minValue(-180), v.maxValue(180));
const priceSchema = v.pipe(v.number(), v.minValue(0));

// Addresses are stored as STRUCTURED parts (see src/lib/address.ts and migrations
// 0008/0009). `street`, `city`, `region`, `country` are REQUIRED; `postcode` is
// optional. Take every part from the venue's OSM/Overture data — never geocode or
// invent one. `region`/`postcode`/`country` are normalized server-side (province
// → 2-letter code, postcode → canonical spacing, country → ISO-2), so a source
// spelling like "Ontario" or "ontario" is accepted and stored as "ON".
const streetSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1, 'street is required and must be non-empty'),
	v.check(
		(s) => /\p{L}/u.test(s),
		'street must be a real street (contain a street name), not just a number'
	)
);
const citySchema = v.pipe(v.string(), v.trim(), v.minLength(1, 'city is required'));
const regionSchema = v.pipe(v.string(), v.trim(), v.minLength(1, 'region is required'));
const postcodeSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const countryPartSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

/** Field descriptions reused on create_locations and update_locations. */
const STREET_DESC =
	'House number + street (+ unit), e.g. "1909 W 4th Ave". Take the street line from the candidate\'s ' +
	'OSM/Overture address; never geocode or invent one.';
const CITY_DESC = 'Municipality, e.g. "Vancouver".';
const REGION_DESC =
	'Province/state — a 2-letter code ("BC") or full name ("British Columbia"); stored as the 2-letter code.';
const POSTCODE_DESC =
	'Postal/ZIP code (optional). Stored canonically (e.g. "V6J 1M5"); omit when the source has none.';
const COUNTRY_DESC =
	'Country — name ("Canada") or ISO-2 code ("CA"); stored as ISO-2. Defaults to CA.';
const OSM_ID_DESC =
	'PREFERRED way to add a venue: the `osm_id` of a search_poi candidate (same local OSM staging ' +
	"store). When set, the server takes this venue's latitude/longitude VERBATIM from that OSM POI — " +
	"guaranteeing the coordinate-exact match the map's de-duplication relies on, so you never copy or " +
	"geocode coordinates — and fills the address from the POI's own addr:* tags, auto-citing its " +
	'osm_url as a source. OMIT latitude/longitude when using osm_id (passing them is rejected). You may ' +
	'still pass street/city/region/postcode/country to override or supply parts the POI lacks (e.g. ' +
	"city/region) — take those from the POI's admin context, never geocode. Fall back to the manual " +
	'latitude/longitude + address only for a venue genuinely not in OSM.';

/**
 * Normalizes raw structured address args into the stored parts, throwing a clear
 * MCP error when a required part cannot be resolved. Reused by create_locations
 * and update_locations so storage stays uniform regardless of how a source spelled
 * a province / postcode / country.
 */
function normalizeAddressParts(args: {
	street: string;
	city: string;
	region: string;
	postcode?: string | null;
	country?: string | null;
}): { street: string; city: string; region: string; postcode: string | null; country: string } {
	const country = normalizeCountry(args.country ?? 'CA') ?? 'CA';
	const region = normalizeRegion(args.region, country);
	if (!region) {
		throw new Error(
			`region "${args.region}" is not a recognized province/state for ${country}. ` +
				'Pass a 2-letter code or full name' +
				(args.country === null || args.country === undefined
					? ` (country defaulted to ${country}; if this venue is elsewhere, pass its country too).`
					: '.')
		);
	}
	let postcode: string | null = null;
	if (args.postcode && args.postcode.trim()) {
		postcode = normalizePostcode(args.postcode, country);
		if (!postcode) {
			throw new Error(
				`postcode "${args.postcode}" is not a valid ${country} postal/ZIP code. ` +
					'Omit it rather than storing a partial code.'
			);
		}
	}
	return { street: args.street.trim(), city: args.city.trim(), region, postcode, country };
}

/**
 * Normalizes only the address parts PRESENT in an update patch (a partial update
 * may touch just one part). region/postcode are validated against the patch's
 * country when given, else auto-detected (CA/US). Throws on an unresolvable value;
 * `postcode: null`/'' clears it.
 */
function normalizeAddressPatch(patch: {
	street?: string;
	city?: string;
	region?: string;
	postcode?: string | null;
	country?: string;
}): Partial<{
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
}> {
	const out: Partial<{
		street: string;
		city: string;
		region: string;
		postcode: string | null;
		country: string;
	}> = {};
	if (patch.country !== undefined) {
		const c = normalizeCountry(patch.country);
		if (!c) throw new Error(`country "${patch.country}" is not a recognized country.`);
		out.country = c;
	}
	if (patch.street !== undefined) out.street = patch.street.trim();
	if (patch.city !== undefined) out.city = patch.city.trim();
	if (patch.region !== undefined) {
		const r = normalizeRegion(patch.region, out.country);
		if (!r) throw new Error(`region "${patch.region}" is not a recognized province/state.`);
		out.region = r;
	}
	if (patch.postcode !== undefined) {
		if (patch.postcode === null || patch.postcode.trim() === '') {
			out.postcode = null;
		} else {
			const p = normalizePostcode(patch.postcode, out.country);
			if (!p) throw new Error(`postcode "${patch.postcode}" is not a valid postal/ZIP code.`);
			out.postcode = p;
		}
	}
	return out;
}

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

// Ingredients are recorded as ingredient tags. `ingredients` is the common case
// (always present); `optional_*` express the per-edge `optional` flag for things
// that can be added or left out. Shared across the create/update item schemas.
const ingredientsSchema = v.optional(
	v.nullable(
		v.pipe(
			v.string(),
			v.description(
				'Comma-separated ingredients; each part is stored as an ingredient tag (canonicalized: ' +
					'lower-cased, accents folded, de-duplicated). ' +
					INGREDIENT_STANDARD_SHORT
			)
		)
	)
);
const optionalIngredientsSchema = v.optional(
	v.nullable(
		v.pipe(
			v.string(),
			v.description(
				'Comma-separated ingredients that are OPTIONAL for this item — added or left out on request ' +
					'(e.g. "cheese, jalapeños"). Stored as ingredient tags flagged optional. ' +
					INGREDIENT_STANDARD_SHORT
			)
		)
	)
);
const optionalTagsSchema = v.optional(
	v.pipe(
		v.array(tagIdSchema),
		v.description(
			'Tags this item can OPTIONALLY satisfy on request (e.g. a dish that can be made vegan). ' +
				'Same id set as `tags`. ' +
				TAG_POLICY_SHORT
		)
	)
);

const idArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('The record id (UUID).'))
});

// One menu item belonging to a single venue's own menu. Shared by create_foods
// (location_id given once for the batch) and the inline `menu_items` of an
// independent venue created via create_locations.
const foodItemSchema = v.object({
	item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
	description: v.optional(v.nullable(v.string())),
	ingredients: ingredientsSchema,
	optional_ingredients: optionalIngredientsSchema,
	price: v.optional(v.nullable(v.pipe(priceSchema, v.description('Price in CAD.')))),
	tags: v.optional(
		v.pipe(v.array(tagIdSchema), v.description('Tags to apply to this item. ' + TAG_POLICY_SHORT))
	),
	optional_tags: optionalTagsSchema,
	sources: createSourcesSchema,
	id: v.optional(v.pipe(v.string(), v.minLength(1)))
});

const createLocationArgs = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.description('Display name of the place.')),
	category: v.optional(
		v.nullable(
			v.pipe(
				categorySchema,
				v.description(
					"One of: cafe, fast_food, restaurant, bakery. With `osm_id`, defaults to the POI's suggested category."
				)
			)
		)
	),
	osm_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description(OSM_ID_DESC))),
	latitude: v.optional(
		v.pipe(
			latitudeSchema,
			v.description(
				'Latitude in decimal degrees. Required without `osm_id`; omit when `osm_id` is set.'
			)
		)
	),
	longitude: v.optional(
		v.pipe(
			longitudeSchema,
			v.description(
				'Longitude in decimal degrees. Required without `osm_id`; omit when `osm_id` is set.'
			)
		)
	),
	street: v.optional(
		v.pipe(streetSchema, v.description(`${STREET_DESC} Required unless \`osm_id\` supplies it.`))
	),
	city: v.optional(
		v.pipe(citySchema, v.description(`${CITY_DESC} Required unless \`osm_id\` supplies it.`))
	),
	region: v.optional(
		v.pipe(regionSchema, v.description(`${REGION_DESC} Required unless \`osm_id\` supplies it.`))
	),
	postcode: v.optional(v.nullable(v.pipe(postcodeSchema, v.description(POSTCODE_DESC)))),
	country: v.optional(v.nullable(v.pipe(countryPartSchema, v.description(COUNTRY_DESC)))),
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
						'Leave unset for an independent venue (use create_foods, or inline `menu_items`, ' +
						'for its own menu).'
				)
			)
		)
	),
	menu_items: v.optional(
		v.pipe(
			v.array(foodItemSchema),
			v.maxLength(200),
			v.description(
				"This INDEPENDENT venue's own menu items, created on its private menu in the SAME atomic " +
					'batch as the location — saving a separate create_foods call. Same item shape as ' +
					'create_foods. Omit for a chain branch (which sets menu_id/brand_id and shares a menu); ' +
					'passing both is rejected.'
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

// One location patch within an update_locations batch. Every field but `id` is
// optional; only the fields present are changed.
const updateLocationItemArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the location to update.')),
	name: v.optional(v.pipe(v.string(), v.minLength(1))),
	category: v.optional(v.nullable(categorySchema)),
	latitude: v.optional(latitudeSchema),
	longitude: v.optional(longitudeSchema),
	street: v.optional(v.pipe(streetSchema, v.description(`Replace the street. ${STREET_DESC}`))),
	city: v.optional(v.pipe(citySchema, v.description(`Replace the city. ${CITY_DESC}`))),
	region: v.optional(v.pipe(regionSchema, v.description(`Replace the region. ${REGION_DESC}`))),
	postcode: v.optional(v.nullable(v.pipe(postcodeSchema, v.description(POSTCODE_DESC)))),
	country: v.optional(
		v.pipe(countryPartSchema, v.description(`Replace the country. ${COUNTRY_DESC}`))
	),
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

const updateLocationsArgs = v.object({
	items: v.pipe(
		v.array(updateLocationItemArgs),
		v.minLength(1),
		v.maxLength(100),
		v.description(
			'Location patches to apply in one atomic batch — pass a single item to edit one place. ' +
				'Each carries an `id` plus only the fields to change. Ideal for mass backfills from ' +
				'find_missing_address / find_coordinate_drift. Ids that do not exist are reported in ' +
				'`not_found_ids` rather than failing the batch.'
		)
	)
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

const findLocationsArgs = v.object({
	query: v.pipe(
		v.string(),
		v.trim(),
		v.minLength(1, 'query must be a non-empty, non-blank substring.'),
		v.description('Case-insensitive substring matched against the location name.')
	),
	near: v.optional(
		v.pipe(
			nearSchema,
			v.description('Only return matches within radius_km of this point, ordered nearest first.')
		)
	),
	category: v.optional(
		v.pipe(categorySchema, v.description('Only return matches in this category.'))
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

const searchTagsArgs = v.object({
	query: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Case-insensitive substring matched against tag names AND known alias spellings. ' +
					'Omit or pass "" to list just the curated dietary/course tags.'
			)
		)
	),
	limit: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(200),
			v.description(`Maximum tags to return (default ${TAG_SEARCH_LIMIT}, max 200).`)
		)
	)
});

// --- OSM POI discovery (reads the local staging store, not D1) ---

const bboxSchema = v.object({
	min_lat: latitudeSchema,
	min_lon: longitudeSchema,
	max_lat: latitudeSchema,
	max_lon: longitudeSchema
});

const searchPoiArgs = v.pipe(
	v.object({
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
			v.pipe(
				v.boolean(),
				v.description('Omit POIs already present in the database (default true).')
			)
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
	}),
	v.check((input) => {
		const hasBbox = input.bbox !== undefined;
		const centreCount = [input.latitude, input.longitude, input.radius_km].filter(
			(value) => value !== undefined
		).length;
		// Exactly one fully-specified area mode: a `bbox`, OR all three centre params.
		// Catches a partial centre (e.g. latitude only) and both-at-once up front,
		// rather than letting search_poi's resolveArea throw deep in the handler.
		return hasBbox ? centreCount === 0 : centreCount === 3;
	}, 'Provide EITHER `bbox` OR all of `latitude`, `longitude` and `radius_km` (not both, and centre coordinates must be complete).')
);

const findDriftArgs = v.object({
	limit: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(200),
			v.description('Maximum mismatched locations to return (default 50, max 200).')
		)
	),
	tolerance_m: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.description(
				'A location counts as OSM-aligned when a name-matching OSM POI sits within this many metres (default 1).'
			)
		)
	),
	search_radius_m: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(50000),
			v.description(
				'How far to look for a name-matching OSM POI before reporting no match (default 250). ' +
					'Widen to hunt relocated/far matches, but then check distance_m — a far match may be a different branch.'
			)
		)
	),
	include_unmatched: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Also report locations with no name-matching OSM POI nearby (default true).')
		)
	)
});

const findMissingAddressArgs = v.object({
	limit: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(200),
			v.description('Maximum flagged locations to return (default 50, max 200).')
		)
	),
	search_radius_m: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(50000),
			v.description(
				'How far to look for a name-matching OSM POI to take the address from (default 250). ' +
					'A location is OSM-sourced, so its source POI sits ~0 m away; widen to hunt relocated ' +
					'matches, but then check distance_m — a far match may be a different branch.'
			)
		)
	),
	include_incomplete: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Also flag locations whose stored address is a streetless fragment — a bare house number ' +
					'or postcode with no letter (e.g. "31", "90210") — not just empty ones (default true).'
			)
		)
	),
	include_unfixable: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Include locations OSM cannot fix (osm_has_no_address, no_osm_match) in the list; they are ' +
					'always counted regardless. Set false for just the actionable, OSM-fixable work list (default true).'
			)
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
	ingredients: ingredientsSchema,
	optional_ingredients: optionalIngredientsSchema,
	price: v.optional(
		v.nullable(
			v.pipe(priceSchema, v.description('Default price; a branch can override it per-location.'))
		)
	),
	tags: v.optional(
		v.pipe(v.array(tagIdSchema), v.description('Tags to apply to this item. ' + TAG_POLICY_SHORT))
	),
	optional_tags: optionalTagsSchema,
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

const updateItemArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the item to update.')),
	menu_id: v.optional(
		v.pipe(v.string(), v.minLength(1), v.description('Move the item to a different menu (rare).'))
	),
	item_name: v.optional(v.pipe(v.string(), v.minLength(1))),
	description: v.optional(v.nullable(v.string())),
	ingredients: v.optional(
		v.nullable(
			v.pipe(
				v.string(),
				v.description(
					'Replaces the full (non-optional) ingredient set for this item; pass "" to clear. ' +
						'Comma-separated; each part stored as an ingredient tag.'
				)
			)
		)
	),
	optional_ingredients: optionalIngredientsSchema,
	price: v.optional(v.nullable(priceSchema)),
	tags: v.optional(
		v.pipe(
			v.array(tagIdSchema),
			v.description(
				'Replaces the full dietary/course tag set for this item (pass [] to clear). ' +
					TAG_POLICY_SHORT
			)
		)
	),
	optional_tags: optionalTagsSchema,
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
	/** MCP behavioural hints advertised to clients (read-only/destructive/idempotent). */
	annotations?: Tool['annotations'];
	handler: (input: v.InferOutput<S>) => unknown;
}

function defineTool<S extends AnySchema>(def: ToolDef<S>): ToolDef<S> {
	return def;
}

// Reusable MCP tool annotation sets. `openWorldHint: false` everywhere — every tool
// operates on our own database or the local OSM store, never an open/external world.
//   READ_ONLY  — pure reads (auto-approvable by clients).
//   CREATE     — additive inserts (not destructive); idempotent only on explicit ids.
//   DESTRUCTIVE— writes that replace or remove existing data; safe to re-run (idempotent).
//     Includes set_location_item_override: it replaces the whole override row, so an
//     {available}-only call clears a previously-set price — a destructive overwrite.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false
} as const;

/** Normalizes optional source labels to null so they match the DB `Source` type. */
function normalizeSources(
	sources: { url: string; label?: string | null }[] | undefined
): { url: string; label: string | null }[] | undefined {
	return sources?.map((s) => ({ url: s.url, label: s.label ?? null }));
}

/**
 * Advisory check: scans an item's `ingredients`/`optional_ingredients` for parts
 * that read like a description/price/serving note rather than a component noun, and
 * returns a labelled warning per offending part. Warn-only — the write still
 * proceeds; the create/update tools attach any warnings to their result so the
 * agent can move that prose into `description`. See the ingredient standard.
 */
function ingredientWarnings(item: {
	item_name: string;
	ingredients?: string | null;
	optional_ingredients?: string | null;
}): string[] {
	const out: string[] = [];
	const fields = [
		['ingredients', item.ingredients],
		['optional_ingredients', item.optional_ingredients]
	] as const;
	for (const [field, raw] of fields) {
		if (!raw) continue;
		for (const part of raw.split(',')) {
			const reason = ingredientProseWarning(part);
			if (reason) out.push(`"${item.item_name}" ${field} "${part.trim()}" ${reason}.`);
		}
	}
	return out;
}

/** Aggregates {@link ingredientWarnings} across a batch of items. */
function collectIngredientWarnings(
	items: { item_name: string; ingredients?: string | null; optional_ingredients?: string | null }[]
): string[] {
	return items.flatMap(ingredientWarnings);
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

type CreateLocationItem = v.InferOutput<typeof createLocationArgs>;

/** Coordinates + normalized address + category + sources, ready for insertLocations. */
interface ResolvedLocationCore {
	latitude: number;
	longitude: number;
	category: v.InferOutput<typeof categorySchema> | null;
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
	sources: { url: string; label: string | null }[] | undefined;
}

/**
 * Resolves one create_locations item's coordinates + address, enforcing the
 * OSM-based coordinate policy. With `osm_id` the coordinates come VERBATIM from the
 * matching staging-store POI (and its osm_url is auto-cited); the address defaults
 * to the POI's own addr:* tags, with any caller-supplied part overriding. Without
 * `osm_id`, latitude/longitude and street/city/region are required and used as
 * given. Throws an MCP-friendly error on unresolved or conflicting input.
 */
function resolveLocationInsertCore(it: CreateLocationItem): ResolvedLocationCore {
	const sources = normalizeSources(it.sources);
	if (it.osm_id) {
		if (it.latitude !== undefined || it.longitude !== undefined) {
			throw new Error(
				`"${it.name}": do not pass latitude/longitude together with osm_id — coordinates are taken ` +
					'verbatim from the OSM POI to guarantee an exact match. Omit them.'
			);
		}
		const poi = getOsmStore().getByOsmId(it.osm_id);
		if (!poi) {
			throw new Error(
				`No OSM POI "${it.osm_id}" in the staging store. Use an osm_id from a search_poi candidate, ` +
					'or omit osm_id and pass latitude/longitude + address for a venue not in OSM.'
			);
		}
		// Caller-supplied parts override the POI's own addr:* tags; absent parts fall
		// back to the POI. (`??` means a caller can't blank a POI-derived part — there's
		// no reason to import a venue and then strip its address, so that's intended.)
		const own = osmOwnAddressParts(poi.tags_json) ?? {};
		const street = it.street ?? own.street;
		const city = it.city ?? own.city;
		const region = it.region ?? own.region;
		const missing = (
			[
				['street', street],
				['city', city],
				['region', region]
			] as const
		)
			.filter(([, value]) => !value)
			.map(([key]) => key);
		if (missing.length) {
			throw new Error(
				`OSM POI "${it.osm_id}" (${poi.name ?? 'unnamed'}) has no ${missing.join('/')} in its ` +
					`addr:* tags — pass ${missing.join(', ')} explicitly (from the POI's admin context; never geocode).`
			);
		}
		const addr = normalizeAddressParts({
			street: street as string,
			city: city as string,
			region: region as string,
			postcode: it.postcode ?? own.postcode ?? null,
			country: it.country ?? own.country ?? null
		});
		const osmHref = osmUrl(poi.osm_type, poi.numeric_id);
		const hasOsmSource = sources?.some((s) => s.url === osmHref) ?? false;
		const withOsmSource: { url: string; label: string | null }[] = hasOsmSource
			? (sources as { url: string; label: string | null }[])
			: [{ url: osmHref, label: 'OpenStreetMap' }, ...(sources ?? [])];
		return {
			latitude: poi.latitude,
			longitude: poi.longitude,
			category: it.category ?? poi.suggested_category ?? null,
			...addr,
			sources: withOsmSource
		};
	}
	if (it.latitude === undefined || it.longitude === undefined) {
		throw new Error(
			`"${it.name}": latitude and longitude are required — or pass an osm_id to import them verbatim from OSM.`
		);
	}
	if (it.street === undefined || it.city === undefined || it.region === undefined) {
		throw new Error(
			`"${it.name}": street, city and region are required — or pass an osm_id to import the address from OSM.`
		);
	}
	return {
		latitude: it.latitude,
		longitude: it.longitude,
		category: it.category ?? null,
		...normalizeAddressParts({
			street: it.street,
			city: it.city,
			region: it.region,
			postcode: it.postcode,
			country: it.country
		}),
		sources
	};
}

/** Lightweight location overview, shared by list_locations and find_locations. */
function projectLocationOverview(loc: LocationWithTags) {
	return {
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
	};
}

/**
 * Shared query path for the location-overview tools. With `near`, pushes the
 * covering bbox (+ filters) into SQL then refines to the exact circle, sorts
 * nearest-first and pages in memory (geo math the DB lacks); without it,
 * category/name/paging push straight into SQL. `nameLike` is a case-insensitive
 * substring match on the location name.
 */
async function queryLocations(opts: {
	near?: { latitude: number; longitude: number; radius_km: number };
	category?: v.InferOutput<typeof categorySchema>;
	nameLike?: string;
	limit?: number;
	offset?: number;
}) {
	const { near, category, nameLike, limit, offset } = opts;
	if (near) {
		const box = bboxAround(near.latitude, near.longitude, near.radius_km);
		const rows = await getLocationsWithTags(getDb(), {
			bbox: { minLat: box.minLat, maxLat: box.maxLat, minLng: box.minLon, maxLng: box.maxLon },
			category,
			nameLike
		});
		const withinCircle = rows
			.map((r) => ({
				r,
				d: haversineMeters(near.latitude, near.longitude, r.latitude, r.longitude) / 1000
			}))
			.filter((x) => x.d <= near.radius_km)
			.toSorted((a, b) => a.d - b.d);
		const start = offset ?? 0;
		const page = withinCircle.slice(start, limit === undefined ? undefined : start + limit);
		return page.map((x) => projectLocationOverview(x.r));
	}
	const rows = await getLocationsWithTags(getDb(), { category, nameLike, limit, offset });
	return rows.map(projectLocationOverview);
}

const tools = [
	defineTool({
		name: 'list_locations',
		annotations: READ_ONLY,
		description:
			'List locations as a lightweight overview — id, name, category, coordinates, address, phone, ' +
			'website, brand_id/menu_id (set for chain branches), and the distinct tag ids offered across the ' +
			'effective menu (no per-item detail, no source URLs). ' +
			'Supports optional `near`/`category` filtering and `limit`/`offset` paging. Use get_location for ' +
			'a single place with its menu and sources.',
		schema: listLocationsArgs,
		handler: ({ near, category, limit, offset }) =>
			queryLocations({ near, category, limit, offset })
	}),
	defineTool({
		name: 'find_locations',
		annotations: READ_ONLY,
		description:
			'Search the LIVE map database for existing locations by name (case-insensitive substring), ' +
			'returning the same lightweight overview as list_locations. Use it to check whether a venue is ' +
			'already on the map (de-dup before adding) or to find a place to edit/inspect by name. This reads ' +
			'the live D1 — distinct from search_poi, which finds OSM venues NOT yet on the map. Optionally ' +
			'narrow with `near`/`category` and page with `limit`/`offset`. For a single place with its full ' +
			'menu and sources, call get_location with the id.',
		schema: findLocationsArgs,
		handler: ({ query, near, category, limit, offset }) =>
			queryLocations({ near, category, nameLike: query, limit, offset })
	}),
	defineTool({
		name: 'get_location',
		annotations: READ_ONLY,
		description:
			'Get a single location with its source URLs. `menu` lists only the items owned directly by this ' +
			'venue (on its own private menu). If `menu_id` is a shared brand menu the location is a chain branch — ' +
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
		annotations: CREATE,
		description:
			'Create one or more locations in a single atomic batch (all-or-nothing) — the only way to add ' +
			'locations; pass a one-item `items` array to add a single place. PREFERRED: give each item the ' +
			"`osm_id` of a search_poi candidate — the server then takes that venue's coordinates VERBATIM " +
			"from OSM (keeping de-duplication coordinate-exact), fills its address from the POI's addr:* " +
			'tags, and auto-cites the osm_url; you supply only brand/menu links and any menu_items, plus ' +
			'street/city/region to override or fill parts the POI lacks. ONLY for a venue genuinely not in ' +
			'OSM, fall back to the manual path: pass latitude/longitude plus a structured address (`street`, ' +
			'`city`, `region`, `country` required, `postcode` optional; never geocode or invent parts). ' +
			'region/postcode/country are normalized for you (e.g. "Ontario" → "ON"). For a chain branch, set ' +
			'`menu_id` (and `brand_id`) so it serves that shared menu; for an INDEPENDENT venue omit them and ' +
			'optionally pass `menu_items` to create its own menu in the SAME batch (else add it later with ' +
			'create_foods). Ideal for bulk imports like backfilling a chain across a region. Idempotent on ' +
			'explicit ids: items whose `id` already exists are skipped (reported in `skipped_existing_ids`), ' +
			'so a retried batch is safe (for a location with inline `menu_items`, give it an explicit `id` ' +
			'too, so its items are skipped with it). If any remaining item is invalid, nothing is written. ' +
			'Returns ' +
			'{ created, location_ids, items_created, item_ids, skipped_existing_ids } — fetch details with ' +
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
			// Idempotency: skip items whose explicit id already exists, so retrying a batch
			// that already landed is a no-op rather than a primary-key collision.
			const explicitIds = items.map((it) => it.id).filter((id): id is string => Boolean(id));
			const already = explicitIds.length
				? await existingIds(getDb(), 'locations', explicitIds)
				: new Set<string>();
			const skippedExistingIds: string[] = [];
			const toInsert = items.filter((it) => {
				if (it.id && already.has(it.id)) {
					skippedExistingIds.push(it.id);
					return false;
				}
				return true;
			});
			// Pre-assign ids to any inline menu_items so we can return them; the location,
			// its private menu and these items all land in the one atomic batch.
			const itemIds: string[] = [];
			const inserts = toInsert.map((it) => {
				if (it.menu_items?.length && (it.brand_id || it.menu_id)) {
					throw new Error(
						`"${it.name}" has \`menu_items\` but is linked to a chain (brand_id/menu_id). Inline items ` +
							`are for an independent venue's own menu; a chain branch shares its menu — use ` +
							`create_menu_items, or set_location_item_override for a per-branch delta.`
					);
				}
				const menuItems = (it.menu_items ?? []).map((mi) => {
					const id = mi.id ?? crypto.randomUUID();
					itemIds.push(id);
					return {
						id,
						item_name: mi.item_name,
						description: mi.description ?? null,
						ingredients: mi.ingredients ?? null,
						optionalIngredients: mi.optional_ingredients ?? null,
						price: mi.price ?? null,
						tags: mi.tags,
						optionalTags: mi.optional_tags,
						sources: normalizeSources(mi.sources)
					};
				});
				const core = resolveLocationInsertCore(it);
				return {
					id: it.id,
					name: it.name,
					category: core.category,
					latitude: core.latitude,
					longitude: core.longitude,
					street: core.street,
					city: core.city,
					region: core.region,
					postcode: core.postcode,
					country: core.country,
					phone: it.phone ?? null,
					website: it.website ?? null,
					brand_id: it.brand_id ?? null,
					menu_id: it.menu_id ?? null,
					sources: core.sources,
					...(menuItems.length ? { items: menuItems } : {})
				};
			});
			const ids = inserts.length ? await insertLocations(getDb(), inserts) : [];
			const warnings = collectIngredientWarnings(toInsert.flatMap((it) => it.menu_items ?? []));
			return {
				created: ids.length,
				location_ids: ids,
				items_created: itemIds.length,
				item_ids: itemIds,
				skipped_existing_ids: skippedExistingIds,
				...(warnings.length ? { warnings } : {})
			};
		}
	}),
	defineTool({
		name: 'update_locations',
		annotations: DESTRUCTIVE,
		description:
			'Update one or more existing locations in a single atomic batch — pass a one-item `items` array to ' +
			'edit one place. Each patch carries an `id` plus only the fields to change; a given `sources` array ' +
			"replaces that location's whole source set (pass [] to clear). Set `menu_id`/`brand_id` to attach a " +
			'branch to a chain menu, or null to detach it. region/postcode/country are normalized for you. ' +
			'Ideal for mass backfills from find_missing_address / find_coordinate_drift. Ids that do not exist ' +
			'are skipped and listed in `not_found_ids`. Returns { updated, updated_ids, not_found_ids }.',
		schema: updateLocationsArgs,
		handler: async ({ items }) => {
			// Validate only the DISTINCT brand/menu pairs a patch actually SETS.
			const checkedPairs = new Set<string>();
			for (const it of items) {
				if (it.brand_id === undefined && it.menu_id === undefined) continue;
				const key = `${it.brand_id ?? ''}|${it.menu_id ?? ''}`;
				if (checkedPairs.has(key)) continue;
				checkedPairs.add(key);
				await assertBrandMenuRefs(it.brand_id, it.menu_id);
			}
			const patches = items.map(
				({ id, sources, street, city, region, postcode, country, ...patch }) => ({
					id,
					...patch,
					...normalizeAddressPatch({ street, city, region, postcode, country }),
					sources: normalizeSources(sources)
				})
			);
			const { updatedIds, notFoundIds } = await updateLocations(getDb(), patches);
			return { updated: updatedIds.length, updated_ids: updatedIds, not_found_ids: notFoundIds };
		}
	}),
	defineTool({
		name: 'delete_location',
		annotations: DESTRUCTIVE,
		description:
			'Delete a location and (by cascade) all of its menu items. Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteLocation(getDb(), id) })
	}),
	defineTool({
		name: 'create_foods',
		annotations: CREATE,
		description:
			'Create one or more menu items for ONE independent venue, on its own private menu (created ' +
			'automatically the first time), in a single transaction (all-or-nothing): ' +
			"if any item is invalid, none are written. Use this for a venue's own menu; for a chain whose branches share a menu, use create_menu_items instead (calling it on a chain branch errors). Pass a " +
			'one-element `items` array to add a single item. Tip: when creating the venue too, pass these as ' +
			'`menu_items` on create_locations to do it in one call. Returns { created, item_ids, skipped_existing_ids } (ids already present are skipped, making retries safe) — read full ' +
			'items with get_item / get_location if needed.',
		schema: createFoodsArgs,
		handler: async (input) => {
			if (!(await getLocationById(getDb(), input.location_id))) {
				throw new Error(`No location with id "${input.location_id}".`);
			}
			const explicitIds = input.items.map((it) => it.id).filter((id): id is string => Boolean(id));
			const already = explicitIds.length
				? await existingIds(getDb(), 'items', explicitIds)
				: new Set<string>();
			const skippedExistingIds: string[] = [];
			const toInsert = input.items.filter((it) => {
				if (it.id && already.has(it.id)) {
					skippedExistingIds.push(it.id);
					return false;
				}
				return true;
			});
			const ids = toInsert.length
				? await insertFoods(
						getDb(),
						toInsert.map((it) => ({
							id: it.id,
							location_id: input.location_id,
							item_name: it.item_name,
							description: it.description ?? null,
							ingredients: it.ingredients ?? null,
							optionalIngredients: it.optional_ingredients ?? null,
							price: it.price ?? null,
							tags: it.tags,
							optionalTags: it.optional_tags,
							sources: normalizeSources(it.sources)
						}))
					)
				: [];
			const warnings = collectIngredientWarnings(toInsert);
			return {
				created: ids.length,
				item_ids: ids,
				skipped_existing_ids: skippedExistingIds,
				...(warnings.length ? { warnings } : {})
			};
		}
	}),
	defineTool({
		name: 'get_item',
		annotations: READ_ONLY,
		description:
			"Get any menu item by id — a venue's own item or a chain's shared one — with its tags " +
			"(dietary, course, ingredient) and source URLs. To browse a venue's items use get_location; " +
			'for a chain menu use get_menu. Returns null if not found.',
		schema: idArgs,
		handler: async ({ id }) => getItemById(getDb(), id)
	}),
	defineTool({
		name: 'update_item',
		annotations: DESTRUCTIVE,
		description:
			'Update any menu item by id. For a shared chain item the change applies to EVERY branch serving ' +
			'its menu — to change just one branch use set_location_item_override instead. Only provided fields ' +
			'change: `tags`/`optional_tags` together replace the dietary/course set; `ingredients`/' +
			'`optional_ingredients` replace the ingredient set; `sources` replaces sources (pass []/"" to ' +
			'clear). Returns the updated item, or null if the id does not exist.',
		schema: updateItemArgs,
		handler: async ({ id, sources, optional_tags, optional_ingredients, ...patch }) => {
			const updated = await updateItem(getDb(), id, {
				...patch,
				optionalTags: optional_tags,
				optionalIngredients: optional_ingredients,
				sources: normalizeSources(sources)
			});
			if (!updated) return null;
			// Only the ingredient fields actually present in this patch are checked.
			const warnings = ingredientWarnings({
				item_name: patch.item_name ?? updated.item_name,
				ingredients: patch.ingredients,
				optional_ingredients
			});
			return warnings.length ? { ...updated, warnings } : updated;
		}
	}),
	defineTool({
		name: 'delete_item',
		annotations: DESTRUCTIVE,
		description:
			"Delete any menu item by id (a venue's own or a chain's shared one, plus any per-location " +
			'overrides of it). A shared item is removed from every branch serving its menu. Returns ' +
			'{ deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteItem(getDb(), id) })
	}),
	defineTool({
		name: 'list_tags',
		annotations: READ_ONLY,
		description:
			'List the canonical, app-defined tags, each with a tag_type (dietary or course). These are fixed ' +
			'and cannot be created via this server. Ingredient tags (tag_type "ingredient") are not listed ' +
			'here — they are data, created automatically from item `ingredients`.',
		schema: v.object({}),
		handler: () => getAllTags()
	}),
	defineTool({
		name: 'search_tags',
		annotations: READ_ONLY,
		description:
			'Search the WHOLE tag vocabulary — the curated dietary/course tags AND the ingredient tags ' +
			'created from item data — by name substring (case-insensitive), best-match first. Use this ' +
			'BEFORE authoring `ingredients` so you REUSE the established tag instead of minting a ' +
			'near-duplicate (find "tomato" before writing "tomatoes"). Variant spellings are resolved ' +
			'through the alias map, so searching "tomatoes", "garbanzo" or "jalapeño" returns the canonical ' +
			'tag. An empty query lists just the curated dietary/course tags. Unlike list_tags (curated only), ' +
			'this exposes the thousands of ingredient tags. Read-only.',
		schema: searchTagsArgs,
		handler: ({ query, limit }) => searchTagVocabulary(getDb(), query ?? '', limit)
	})
] as const;

// Chain tools: brands → menus → shared menu items, plus per-location overrides.
// Kept in a separate array purely for grouping; merged into `allTools` below.
const chainTools = [
	defineTool({
		name: 'create_brand',
		annotations: CREATE,
		description:
			"Create a chain/brand (e.g. McDonald's). A brand owns one or more regional menus (create_menu); " +
			'a location joins the chain by setting its brand_id/menu_id. Returns { id } — read it back with get_brand.',
		schema: createBrandArgs,
		handler: async (input) => {
			// Idempotent on an explicit id: a retry that already created the brand is a no-op.
			if (input.id && (await getBrandById(getDb(), input.id))) {
				return { id: input.id, already_existed: true };
			}
			const id = await insertBrand(getDb(), {
				id: input.id,
				name: input.name,
				website: input.website ?? null,
				logo_url: input.logo_url ?? null
			});
			return { id, already_existed: false };
		}
	}),
	defineTool({
		name: 'list_brands',
		annotations: READ_ONLY,
		description:
			'List all chains/brands (id, name, website, logo_url). Use get_brand for one brand with its menus.',
		schema: v.object({}),
		handler: () => getBrands(getDb())
	}),
	defineTool({
		name: 'get_brand',
		annotations: READ_ONLY,
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
		annotations: DESTRUCTIVE,
		description:
			'Update a brand. Only provided fields change. Returns the updated brand, or null if the id does not exist.',
		schema: updateBrandArgs,
		handler: ({ id, ...patch }) => updateBrand(getDb(), id, patch)
	}),
	defineTool({
		name: 'delete_brand',
		annotations: DESTRUCTIVE,
		description:
			'Delete a brand and (by cascade) its menus and their items. Branches that referenced it revert to ' +
			'independent (brand_id/menu_id cleared). Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteBrand(getDb(), id) })
	}),
	defineTool({
		name: 'create_menu',
		annotations: CREATE,
		description:
			'Create a regional menu under a brand (e.g. name "Subway UK", region "GB"). Add its shared items ' +
			'with create_menu_items, then point each branch at it via location.menu_id. Optionally cite the ' +
			'official menu once via `sources`. Returns { id } — read it back with get_menu.',
		schema: createMenuArgs,
		handler: async (input) => {
			if (!(await getBrandById(getDb(), input.brand_id))) {
				throw new Error(`No brand with id "${input.brand_id}".`);
			}
			// Idempotent on an explicit id: a retry that already created the menu is a no-op.
			if (input.id && (await getMenuById(getDb(), input.id))) {
				return { id: input.id, already_existed: true };
			}
			const id = await insertMenu(getDb(), {
				id: input.id,
				brand_id: input.brand_id,
				name: input.name,
				region: input.region ?? null,
				last_verified: input.last_verified ?? null,
				sources: normalizeSources(input.sources)
			});
			return { id, already_existed: false };
		}
	}),
	defineTool({
		name: 'list_menus',
		annotations: READ_ONLY,
		description:
			'List menus (id, brand_id, name, region, last_verified, item_count), optionally filtered to one ' +
			"brand. Use get_menu for a menu's items.",
		schema: listMenusArgs,
		handler: ({ brand_id }) => getMenus(getDb(), brand_id)
	}),
	defineTool({
		name: 'get_menu',
		annotations: READ_ONLY,
		description:
			"Get a menu with its full item list (each item carries its tags and sources) and the menu's own " +
			'source URLs. Returns null if not found.',
		schema: idArgs,
		handler: ({ id }) => getMenuWithItems(getDb(), id)
	}),
	defineTool({
		name: 'update_menu',
		annotations: DESTRUCTIVE,
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
		annotations: DESTRUCTIVE,
		description:
			'Delete a menu and (by cascade) its items. Branches serving it revert to independent (menu_id ' +
			'cleared). Returns { deleted: true } if a row was removed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteMenu(getDb(), id) })
	}),
	defineTool({
		name: 'create_menu_items',
		annotations: CREATE,
		description:
			'Create one or more SHARED items on a brand menu in one transaction (all-or-nothing). Defined once ' +
			'here, they appear at every branch serving this menu — never copy them per location. For an ' +
			"independent venue's own menu use create_foods instead. Returns { created, item_ids, skipped_existing_ids } (ids already present are skipped, making retries safe) — read full " +
			'items with get_item / get_menu if needed.',
		schema: createMenuItemsArgs,
		handler: async (input) => {
			if (!(await getMenuById(getDb(), input.menu_id))) {
				throw new Error(`No menu with id "${input.menu_id}".`);
			}
			const explicitIds = input.items.map((it) => it.id).filter((id): id is string => Boolean(id));
			const already = explicitIds.length
				? await existingIds(getDb(), 'items', explicitIds)
				: new Set<string>();
			const skippedExistingIds: string[] = [];
			const toInsert = input.items.filter((it) => {
				if (it.id && already.has(it.id)) {
					skippedExistingIds.push(it.id);
					return false;
				}
				return true;
			});
			const ids = toInsert.length
				? await insertMenuItems(
						getDb(),
						toInsert.map((it) => ({
							id: it.id,
							menu_id: input.menu_id,
							item_name: it.item_name,
							description: it.description ?? null,
							ingredients: it.ingredients ?? null,
							optionalIngredients: it.optional_ingredients ?? null,
							price: it.price ?? null,
							tags: it.tags,
							optionalTags: it.optional_tags,
							sources: normalizeSources(it.sources)
						}))
					)
				: [];
			const warnings = collectIngredientWarnings(toInsert);
			return {
				created: ids.length,
				item_ids: ids,
				skipped_existing_ids: skippedExistingIds,
				...(warnings.length ? { warnings } : {})
			};
		}
	}),
	defineTool({
		name: 'set_location_item_override',
		annotations: DESTRUCTIVE,
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
		annotations: DESTRUCTIVE,
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
		annotations: READ_ONLY,
		description:
			'Find OpenStreetMap food venues to add to the map, from the LOCAL OSM staging store ' +
			'(built offline via `bun run osm:extract`; not the live D1). Give either a centre ' +
			'(latitude + longitude + radius_km) or a `bbox`. By default it omits venues already in ' +
			'the database (set exclude_existing=false to see all), so you get only what is still ' +
			'missing — ordered nearest-first for centre+radius queries. Each candidate includes an ' +
			'`osm_id` and `osm_url`, a `suggested_category` (cafe/fast_food/restaurant/bakery, ' +
			'or null for bars/pubs/ice_cream/food_court — pick the best fit), OSM ' +
			'phone/website/cuisine/opening_hours where tagged, and a single-line `address` plus ' +
			'structured `address_parts`. Workflow: call this, then create_locations passing each ' +
			"candidate's `osm_id` — the server then takes that venue's coordinates VERBATIM from OSM " +
			'and fills its address from the POI, auto-citing the osm_url, so you never copy or geocode ' +
			'coordinates by hand.',
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
	}),
	defineTool({
		name: 'find_coordinate_drift',
		annotations: READ_ONLY,
		description:
			'Audit existing locations against the LOCAL OSM staging store and surface those whose stored ' +
			'coordinates do NOT coincide with their OpenStreetMap POI — i.e. coordinate drift. Coordinates ' +
			'must be OSM-sourced (see create_locations), so a healthy location sits ~0 m from its OSM POI; ' +
			'this finds the exceptions so they can be snapped back. Each `drifted` entry carries the matched ' +
			'OSM POI (`osm_url`, `osm_latitude`, `osm_longitude`, `distance_m`, `matched_osm_name`) — pass ' +
			'`osm_latitude`/`osm_longitude` straight to update_locations to fix it, and cite `osm_url`. ' +
			'Locations with no name-matching OSM POI nearby are reported as `no_osm_match` (these have no ' +
			'OSM counterpart to align to; set include_unmatched=false to omit them). Results are ' +
			'worst-drift-first; `limit` caps how many are returned and `additional` is how many more ' +
			'mismatches exist beyond it, with a `counts` breakdown by classification.',
		schema: findDriftArgs,
		handler: async (input) =>
			findCoordinateDrift(getOsmStore(), getDb(), {
				limit: input.limit,
				tolerance_m: input.tolerance_m,
				search_radius_m: input.search_radius_m,
				include_unmatched: input.include_unmatched
			})
	}),
	defineTool({
		name: 'find_missing_address',
		annotations: READ_ONLY,
		description:
			'Audit existing locations for a MISSING address and, where possible, surface the address from ' +
			'their OpenStreetMap POI so it can be backfilled. Addresses should be present and OSM-sourced, ' +
			'like coordinates (see create_locations), so a location sits ~0 m from the OSM POI its address ' +
			'should come from. Flags any location whose stored address is empty (`reason: "missing"`) or — ' +
			'unless include_incomplete=false — a streetless fragment like a bare house number/postcode ' +
			'(`reason: "incomplete"`). Each entry is classified by what can be done: `osm_fix_available` ' +
			'(a name-matching OSM POI nearby HAS an address — pass its structured `osm_address_parts` to ' +
			'update_locations, or split the `osm_address` preview into parts when `osm_address_parts` is ' +
			'absent, and cite `osm_url`), `osm_has_no_address` (matched a POI, but it too lacks one ' +
			'— needs another source), or `no_osm_match` (no name-matching POI within search_radius_m). ' +
			'Results are actionable-first; set include_unfixable=false for just the OSM-fixable work list. ' +
			'`limit` caps how many are returned, `additional` is how many more were flagged beyond it, and ' +
			'`counts` breaks them down by classification and reason.',
		schema: findMissingAddressArgs,
		handler: async (input) =>
			findMissingAddress(getOsmStore(), getDb(), {
				limit: input.limit,
				search_radius_m: input.search_radius_m,
				include_incomplete: input.include_incomplete,
				include_unfixable: input.include_unfixable
			})
	})
] as const;

const allTools = [...tools, ...chainTools, ...osmTools];

const toolsByName = new Map(allTools.map((t) => [t.name, t] as const));

/** valibot → JSON Schema for the MCP `inputSchema` field. */
function inputSchemaFor(schema: AnySchema): Tool['inputSchema'] {
	// errorMode 'ignore': skip actions that have no JSON Schema representation
	// (e.g. `trim`, custom `check`) rather than throwing — they are still applied
	// by v.parse at call time, so validation is unaffected; only the advertised
	// hint omits what JSON Schema can't express.
	const json = toJsonSchema(schema, { errorMode: 'ignore' }) as Record<string, unknown>;
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
		inputSchema: inputSchemaFor(t.schema),
		...(t.annotations ? { annotations: t.annotations } : {})
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
