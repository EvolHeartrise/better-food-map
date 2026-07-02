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
	assertBrandMenuRefs,
	countMenuItems,
	getLocationsWithTags,
	getLocationById,
	getFoodByLocation,
	getItemById,
	updateItems,
	deleteItem,
	insertLocations,
	insertFoods,
	updateLocations,
	deleteLocation,
	setLocationClosed,
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
	existingLocationsAtCoords,
	coordinateKey,
	countLocations,
	openLocationsInBbox,
	findBrandIdsByName,
	findMenuIdsByName,
	itemNameCollisions,
	markLocationsDistinct,
	unmarkLocationsDistinct,
	DEFAULT_CURRENCY,
	TAGS,
	type Bounds,
	type D1Like,
	type Item,
	type LocationWithTags
} from '../src/lib/server/db';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { CATEGORIES } from '../src/lib/category';
import { sourceInputSchema } from './mcp/source-input';
import { ToolPartialFailure, partialFailureBody } from './mcp/partial-failure';
import { normalizeRegion, normalizePostcode, normalizeCountry } from '../src/lib/address';
import { hasNonHttpScheme } from '../src/lib/safe-url';
import { searchPoi, normalizeName, namesMatch } from './osm/search-poi';
import { selectChainCandidates, partitionImportable } from './osm/import-chain';
import { findCoordinateDrift } from './osm/find-coordinate-drift';
import { findMissingAddress } from './osm/find-missing-address';
import { findDuplicateLocations } from './osm/find-duplicate-locations';
import { OsmPoiStore } from './osm/poi-store';
import { effectivePoiAddressParts, osmUrl } from './osm/map-feature';
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

const categorySchema = v.picklist(CATEGORIES);
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
	'Data model — every location serves a menu of items. Add items with create_items, ' +
	'targeting EITHER a venue or a shared menu:\n' +
	'• INDEPENDENT venue: call create_items with a `location_id`. Its items live on a private ' +
	'menu created automatically for that one location (browse them via get_location). Tip: when ' +
	'creating the venue, pass the items inline as `menu_items` on create_locations to do it in one call.\n' +
	"• CHAIN (McDonald's, Subway, …): create a `brand`, then one `menu` per region " +
	'(e.g. "Subway UK"), then the menu\'s shared items once with create_items using a `menu_id` ' +
	'(browse them via get_menu). Point each branch at that menu by setting its `menu_id` (and ' +
	"`brand_id`) via create_locations/update_locations — every such location then serves the menu's " +
	'items automatically, with no per-location copies. Where one branch differs ' +
	'(item sold out, regional price), record just that delta with set_location_item_override.\n' +
	'Rule of thumb: create_items with a menu_id for items shared across branches; with a location_id ' +
	'for one venue. Once created, read/edit/remove items with get_item / update_items / delete_item ' +
	'(editing a shared chain item changes it for every branch).\n' +
	'Items carry tags: pass `tags` (dietary/course) and `optional_tags` for things that can be added ' +
	'or left out (e.g. an item that can be made vegan). Items do NOT store ingredients.';

const SERVER_INSTRUCTIONS =
	'CRUD tools over the food-map database (locations, chains/brands, and their menu items). Each ' +
	'location, menu, and item may carry source URLs documenting where the data came from — include ' +
	'them whenever you add scraped data so it stays verifiable.\n\n' +
	'To find venues still missing from the map, use search_poi: it reads a local OpenStreetMap ' +
	'food-POI staging store (built offline, not the live D1), already de-duplicated against existing ' +
	'locations, and returns candidates each carrying an `osm_id` (pass it to create_locations to ' +
	'import OSM coordinates + address verbatim) — then add each with create_locations. To import a ' +
	"CHAIN's branches, do NOT loop search_poi/create_locations by hand: create the brand, its shared " +
	'menu and the menu items, then call import_chain once (dry_run first to vet the name allowlist; ' +
	"pass `brand_wikidata` to catch name variants via OSM's brand tag, and `country` to keep " +
	'neighbouring-country border POIs out) — it scans the whole area, filters by name, and imports ' +
	'every branch with OSM-verbatim coordinates/addresses in one call. After bulk imports, ' +
	'audit_locations ' +
	'(check: "duplicate_locations") finds same-name pairs a few metres apart — OSM sometimes maps one ' +
	`venue twice; verify against the venue's own locator, then delete_location the extra row, or ` +
	'mark_not_duplicate a verified two-real-venues pair so it is never re-flagged.\n\n' +
	`${MODEL_OVERVIEW}\n\nTag policy: ${TAG_POLICY}`;

const latitudeSchema = v.pipe(v.number(), v.minValue(-90), v.maxValue(90));
const longitudeSchema = v.pipe(v.number(), v.minValue(-180), v.maxValue(180));
const priceSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

// Currency is a property of the MENU (one region → one currency), so prices on it
// are unambiguous. Stored upper-case; accepted as any case. Defaults to CAD.
const currencySchema = v.pipe(
	v.string(),
	v.trim(),
	v.transform((s) => s.toUpperCase()),
	v.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code, e.g. "CAD", "USD", "GBP".'),
	v.description(
		`ISO 4217 currency code for this menu's prices, e.g. "CAD", "USD", "GBP". ` +
			`Case-insensitive; stored upper-case. Defaults to ${DEFAULT_CURRENCY}.`
	)
);

// An ISO-2 country scope for the POI tools (search_poi / import_chain). Folded
// through the SAME normalizeCountry the write path and poiCountry use, so the
// scope and the per-POI signal can never disagree on spelling: "UK"/"uk"/
// "United Kingdom" all become "GB". A raw string compare here would silently
// invert the filter (scope "UK" vs signal "GB" drops every UK POI).
const countryScopeSchema = v.pipe(
	v.string(),
	v.trim(),
	v.check(
		(s) => normalizeCountry(s) !== null,
		'country must be an ISO-3166-1 code or a recognized country name, e.g. "CA", "US", "GB"/"UK".'
	),
	v.transform((s) => normalizeCountry(s) as string)
);

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
// Websites are rendered as anchor hrefs in the placecard, so reject values
// smuggling a non-http(s) scheme (javascript:, data:, …). Scheme-less values
// pass — the render-side allowlist shows those as plain text, not a link.
const websiteSchema = v.pipe(
	v.string(),
	v.check(
		(s) => !hasNonHttpScheme(s),
		'website must be an http(s) URL (no javascript:/data:/other schemes)'
	)
);

/** Field descriptions reused on create_locations and update_locations. */
const NAME_DESC =
	'The venue\'s own business/brand name as the source displays it, e.g. "A&W" or "Cactus Club ' +
	'Cafe" — and NOTHING else. NEVER bake location data into the name to tell branches apart: no ' +
	'street, intersection, city, neighbourhood, mall/plaza, or landmark, and no parenthetical/suffix ' +
	'locator like "(Scott Road)", "- 72 Ave", or " Surrey". Branches at different addresses are ' +
	'EXPECTED to share an identical name — the map tells them apart by their address/coordinates, not ' +
	'by the name. No editorial annotation either: no former name like "(formerly Bandidas Taqueria)", ' +
	'status note like "(closed)", or tacked-on descriptor like "(Tea & Coffee)" — that prose has no ' +
	"place in the name. When adding from OSM, use the POI's `name` tag verbatim (dropping any such " +
	'locator/annotation). Keep a word that only looks like an addition when the source shows it AS the ' +
	'name (e.g. "Published on Main", "MeeT on Main", "Almond Dosa - Pure Vegetarian"); the test is ' +
	'whether the venue calls itself that, not whether it locates or describes a branch.';
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
 * MCP error when a required part cannot be resolved. An invalid/partial postcode
 * is DROPPED with a warning rather than failing the whole record (the stated
 * policy: a half code is worse than none) — sources routinely carry a bare FSA,
 * and one bad optional part must not sink an otherwise-importable venue. Reused
 * by create_locations and import_chain so storage stays uniform regardless of
 * how a source spelled a province / postcode / country.
 */
function normalizeAddressParts(
	args: {
		street: string;
		city: string;
		region: string;
		postcode?: string | null;
		country?: string | null;
	},
	warn: (message: string) => void
): { street: string; city: string; region: string; postcode: string | null; country: string } {
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
			warn(
				`postcode "${args.postcode}" is not a valid ${country} postal/ZIP code — dropped ` +
					'(a partial code is worse than none); the location was still created.'
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
// Reused on create_* (append) and update_* (replace wholesale). The wording
// nudges the scraping agent to cite where any added data came from. Each entry
// is a bare URL string or a { url, label } object (see source-input.ts).
const createSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			'Source URLs documenting where this data came from (each: a URL string, or { url, label }). ' +
				'Strongly encouraged whenever you add scraped data, so it stays verifiable. ' +
				'May be omitted or [] when you genuinely have no source.'
		)
	)
);

const updateSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			'REPLACES the full source set (each: a URL string, or { url, label }). Pass [] to clear all ' +
				'sources. To ADD a citation without resending the existing ones, use `add_sources` instead. ' +
				'Encouraged: keep at least one source documenting where the data came from.'
		)
	)
);

const addSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			'APPENDS these sources to the existing set (de-duplicated by url); existing sources are kept. ' +
				'Each: a URL string, or { url, label }. Use this to add a citation without re-sending the full ' +
				'set. Mutually exclusive with `sources` (which replaces) — passing both is rejected.'
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

const closeLocationArgs = v.object({
	id: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Id of the location to mark permanently closed (or to reopen).')
	),
	reason: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				'Short note with the closure evidence, stored on the row (e.g. "Closed 2024 per Yelp + dead ' +
					'site"). Strongly encouraged when closing; ignored when `reopen` is true.'
			)
		)
	),
	reopen: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Set true to REOPEN a venue previously marked closed — clears closed_at/closed_reason so it ' +
					'reappears on the map. Omit (or false) to close it.'
			)
		)
	),
	sources: addSourcesSchema
});

// One menu item. Shared by create_items (the batch's location_id/menu_id is given
// once), and by the inline `menu_items` of an independent venue created via
// create_locations.
const itemSchema = v.object({
	item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
	description: v.optional(v.nullable(v.string())),
	price: v.optional(
		v.nullable(
			v.pipe(
				priceSchema,
				v.description(
					"Price in the menu's currency (a bare number, no symbol; the menu's currency defaults to " +
						`${DEFAULT_CURRENCY}). For a shared chain item this is the default a branch can override ` +
						'per-location via set_location_item_override.'
				)
			)
		)
	),
	tags: v.optional(
		v.pipe(v.array(tagIdSchema), v.description('Tags to apply to this item. ' + TAG_POLICY_SHORT))
	),
	optional_tags: optionalTagsSchema,
	sources: createSourcesSchema,
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Optional explicit id; a UUID is generated when omitted.')
		)
	)
});

const createLocationArgs = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.description(NAME_DESC)),
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
	website: v.optional(v.nullable(websiteSchema)),
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
						'Pass the owning `brand_id` with it. Leave unset for an independent venue ' +
						'(use create_items, or inline `menu_items`, for its own menu).'
				)
			)
		)
	),
	currency: v.optional(
		v.pipe(
			currencySchema,
			v.description(
				"Currency for this INDEPENDENT venue's own menu (used with `menu_items`). " +
					`Defaults to ${DEFAULT_CURRENCY}. Ignored for a chain branch, which uses its menu's currency.`
			)
		)
	),
	menu_items: v.optional(
		v.pipe(
			v.array(itemSchema),
			v.maxLength(200),
			v.description(
				"This INDEPENDENT venue's own menu items, created on its private menu in the SAME atomic " +
					'batch as the location — saving a separate create_items call. Same item shape as ' +
					'create_items. Omit for a chain branch (which sets menu_id/brand_id and shares a menu); ' +
					'passing both is rejected.'
			)
		)
	),
	sources: createSourcesSchema,
	closed_reason: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				'Mark this venue PERMANENTLY CLOSED at import (a "born-closed" tombstone): a short reason WITH ' +
					'the closure evidence, e.g. "Permanently closed — Yelp lists closed + website dead (2024)". Use ' +
					'this ONLY for a venue not yet on the map that you have verified is closed: it records the closure ' +
					'so search_poi never re-suggests the POI and the map hides it, WITHOUT spending time on a menu. ' +
					'Must NOT be combined with `menu_items` (a closed venue has no menu). To close a venue ALREADY on ' +
					"the map, use close_location instead — it preserves that venue's likes."
			)
		)
	),
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
			'Locations to create in one batch. Pass a single item to add one place. ' +
				'Ideal for bulk imports such as backfilling a chain across a region — set the same brand_id and ' +
				'menu_id on every item so each branch serves the shared menu, and cite each source (e.g. the ' +
				'osm_url from search_poi). Keep batches to ~50 items. For importing a whole chain from the OSM ' +
				'staging store, prefer import_chain (one call replaces the search_poi → create_locations loop).'
		)
	),
	skip_invalid: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'When true, an item that fails to resolve (e.g. an OSM POI with no recoverable street) is ' +
					'SKIPPED and reported in `skipped_invalid` with its reason, and the valid items are still ' +
					'created. Default false: any invalid item fails the whole batch (nothing is written), with ' +
					'EVERY failing item listed in the error so one round-trip surfaces all of them.'
			)
		)
	)
});

// One location patch within an update_locations batch. Every field but `id` is
// optional; only the fields present are changed.
const updateLocationItemArgs = v.pipe(
	v.object({
		id: v.pipe(v.string(), v.minLength(1), v.description('Id of the location to update.')),
		name: v.optional(
			v.pipe(v.string(), v.minLength(1), v.description(`Replace the name. ${NAME_DESC}`))
		),
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
		website: v.optional(v.nullable(websiteSchema)),
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
					v.description(
						'Assign/replace the shared menu this branch serves (pass the owning `brand_id` ' +
							'with it); null detaches it.'
					)
				)
			)
		),
		sources: updateSourcesSchema,
		add_sources: addSourcesSchema
	}),
	v.check(
		(p) => (p.latitude === undefined) === (p.longitude === undefined),
		'Pass `latitude` and `longitude` together (copied verbatim from the OSM POI) or neither — ' +
			'a single-axis patch would move the venue to a point no OSM POI occupies.'
	)
);

const updateLocationsArgs = v.object({
	items: v.pipe(
		v.array(updateLocationItemArgs),
		v.minLength(1),
		v.maxLength(100),
		v.description(
			'Location patches to apply in one atomic batch — pass a single item to edit one place. ' +
				'Each carries an `id` plus only the fields to change. Ideal for mass backfills from ' +
				'audit_locations. Ids that do not exist are reported in ' +
				'`not_found_ids` rather than failing the batch.'
		)
	)
});

const createItemsArgs = v.pipe(
	v.object({
		location_id: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					"Add the items to THIS independent venue's own private menu (created on first use). " +
						'Use for an independent venue; pass `menu_id` instead for a shared chain menu. ' +
						'Exactly one of location_id / menu_id is required.'
				)
			)
		),
		menu_id: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					'Add the items to THIS shared brand menu — they then appear at every branch serving it. ' +
						'Use for a chain; pass `location_id` instead for an independent venue. ' +
						'Exactly one of location_id / menu_id is required.'
				)
			)
		),
		currency: v.optional(
			v.pipe(
				currencySchema,
				v.description(
					`Currency for an INDEPENDENT venue's menu (with \`location_id\`), applied only when its ` +
						`private menu is first created. Defaults to ${DEFAULT_CURRENCY}. Ignored with \`menu_id\` ` +
						`(the menu already has a currency); to change an existing menu's currency use update_menu.`
				)
			)
		),
		items: v.pipe(
			v.array(itemSchema),
			v.minLength(1),
			v.description('The menu items to create, inserted atomically (all-or-nothing).')
		)
	}),
	v.check(
		(input) => (input.location_id !== undefined) !== (input.menu_id !== undefined),
		'Pass exactly one of `location_id` (an independent venue) or `menu_id` (a shared chain menu).'
	)
);

const nearSchema = v.object({
	latitude: v.pipe(latitudeSchema, v.description('Centre latitude in decimal degrees.')),
	longitude: v.pipe(longitudeSchema, v.description('Centre longitude in decimal degrees.')),
	radius_km: v.pipe(v.number(), v.minValue(0), v.description('Radius in kilometres.'))
});

const listLocationsArgs = v.object({
	query: v.optional(
		v.pipe(
			v.string(),
			v.trim(),
			v.minLength(1, 'query must be a non-empty, non-blank substring.'),
			v.description(
				'Optional case-insensitive substring matched against the location name — use it to find a ' +
					'venue by name (e.g. to de-dup before adding, or to locate one to edit). Omit to list all.'
			)
		)
	),
	near: v.optional(
		v.pipe(
			nearSchema,
			v.description('Only return locations within radius_km of this point, ordered nearest first.')
		)
	),
	category: v.optional(
		v.pipe(categorySchema, v.description('Only return locations in this category.'))
	),
	brand_id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				"Only branches of this chain (exact brand_id match) — the reliable way to enumerate or count a chain's branches, unlike a name substring."
			)
		)
	),
	count_only: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Return just { count } of matching locations instead of the rows — e.g. to size a chain ' +
					'before paging, or to audit branch counts cheaply. `limit`/`offset` are ignored.'
			)
		)
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

// --- OSM POI discovery (reads the local staging store, not D1) ---

const bboxSchema = v.object({
	min_lat: latitudeSchema,
	min_lon: longitudeSchema,
	max_lat: latitudeSchema,
	max_lon: longitudeSchema
});

/** MCP wire bbox (snake_case) → the shared {@link Bounds} shape everything internal uses. */
function toBounds(b: v.InferOutput<typeof bboxSchema>): Bounds {
	return { minLat: b.min_lat, maxLat: b.max_lat, minLng: b.min_lon, maxLng: b.max_lon };
}

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
		country: v.optional(
			v.pipe(
				countryScopeSchema,
				v.description(
					'ISO-2 country scope, e.g. "CA". Drops POIs whose address SIGNALS a different country ' +
						'(explicit addr:country, or a region code belonging to another country); POIs with no ' +
						'country signal are kept. Recommended for border-spanning areas — a Canada extract carries ' +
						'some US border-town POIs. Dropped count returned as `excluded_foreign`.'
				)
			)
		),
		exclude_existing: v.optional(
			v.pipe(
				v.boolean(),
				v.description('Omit POIs already present in the database (default true).')
			)
		),
		exclude_osm_ids: v.optional(
			v.pipe(
				v.array(v.pipe(v.string(), v.minLength(1))),
				v.maxLength(1000),
				v.description(
					'osm_ids to drop from the results — e.g. known false name matches, so they stop ' +
						'resurfacing on every re-search of the same area. Applied before `limit`.'
				)
			)
		),
		compact: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Return the minimal per-candidate shape instead: { osm_id, name, suggested_category, ' +
						'latitude, longitude, has_address, distance_m? } (has_address: "full" = street+city+region ' +
						'all resolvable, "partial", or "none"). Use for large sweeps (limit 200) so the result ' +
						'stays well under tool-output caps — an osm_id import needs nothing more; fetch details ' +
						'for specific candidates with a non-compact call if needed.'
				)
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

const importChainArgs = v.pipe(
	v.object({
		brand_id: v.pipe(
			v.string(),
			v.minLength(1),
			v.description('The chain (create_brand) every imported branch belongs to.')
		),
		menu_id: v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				'The shared regional menu (create_menu) every imported branch serves — create the brand, ' +
					'menu and its items FIRST, then import the branches.'
			)
		),
		location_name: v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				'The canonical name stored on every imported branch, e.g. "Harvey\'s". ' + NAME_DESC
			)
		),
		name_match: v.pipe(
			v.array(v.pipe(v.string(), v.minLength(1))),
			v.minLength(1),
			v.maxLength(50),
			v.description(
				'Source names accepted as this chain, matched STRICTLY by normalized equality (case, accents, ' +
					'punctuation and "&"/"and" folded) — e.g. ["Mary Brown\'s", "Mary Brown\'s Chicken", ' +
					'"Mary Browns"]. POIs whose name is not an exact normalized match are NEVER imported; they ' +
					'come back counted in `name_buckets`, so run dry_run first and extend this list from what ' +
					'you see there (also passing `brand_wikidata` catches most variants automatically).'
			)
		),
		brand_wikidata: v.optional(
			v.pipe(
				v.string(),
				v.trim(),
				v.transform((s) => s.toUpperCase()),
				v.regex(/^Q\d+$/, 'brand_wikidata must be a Wikidata QID, e.g. "Q37158".'),
				v.description(
					"The chain's Wikidata QID, matched against each POI's OSM `brand:wikidata` tag (e.g. " +
						'"Q37158" for Starbucks — dry_run first and read it off the main bucket\'s ' +
						'`brand_wikidata` annotation). ALSO accepts name variants no allowlist entry anticipated ' +
						'("Tim Hortons Express"), but only on TWO-SIGNAL agreement: the POI name must still ' +
						'contain (or be contained by) an accepted name. A brand-tagged POI with a conflicting ' +
						'name (a real OSM mistag pattern, e.g. a "Second Cup" carrying the Starbucks QID) is ' +
						'never imported, and neither is a co-branded unit name ("Wendy\'s / Tim Hortons" — ' +
						"importing it under one chain would block the other chain's import of that venue) — both " +
						'stay in `name_buckets` with their QID for explicit vetting. Buckets whose POIs were ' +
						'accepted via this path are flagged `matched_via_brand: true` in the dry run — review ' +
						'them like any allowlist extension.'
				)
			)
		),
		country: v.optional(
			v.pipe(
				countryScopeSchema,
				v.description(
					'ISO-2 country scope, e.g. "CA". Drops POIs whose address signals a different country before ' +
						'matching (counted in `excluded_foreign`); POIs with no country signal are kept. ' +
						'Recommended for country-wide imports — a Canada extract carries some US border-town POIs ' +
						'that would otherwise fail (or worse, import) under the wrong country.'
				)
			)
		),
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
				v.description('Bounding box to import from. Provide this OR latitude+longitude+radius_km.')
			)
		),
		category: v.optional(
			v.pipe(
				categorySchema,
				v.description(
					"Force this category on every branch; omit to use each POI's suggested category."
				)
			)
		),
		website: v.optional(
			v.pipe(
				websiteSchema,
				v.minLength(1),
				v.description(
					"Fallback website for branches whose POI has none tagged (typically the chain's own site)."
				)
			)
		),
		max: v.optional(
			v.pipe(
				v.number(),
				v.integer(),
				v.minValue(1),
				v.maxValue(1000),
				v.description(
					'Cap on branches imported in this call (default 500), applied to the IMPORTABLE candidates ' +
						'only — address-unresolvable POIs are summarized in `skipped_unresolvable` and never ' +
						'consume the cap. Anything beyond it is counted in `remaining_beyond_max` — call again to ' +
						'continue (already-imported branches are excluded automatically).'
				)
			)
		),
		include_location_ids: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Also return the created location ids (default false — a 1000-branch import would return ' +
						'1000 UUIDs; enumerate branches later with list_locations brand_id instead).'
				)
			)
		),
		dry_run: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Preview without writing: how many branches would import, the full `name_buckets` histogram ' +
						'(to vet the allowlist), and a sample of candidates. ALWAYS dry-run a new chain first.'
				)
			)
		)
	}),
	v.check((input) => {
		const hasBbox = input.bbox !== undefined;
		const centreCount = [input.latitude, input.longitude, input.radius_km].filter(
			(value) => value !== undefined
		).length;
		return hasBbox ? centreCount === 0 : centreCount === 3;
	}, 'Provide EITHER `bbox` OR all of `latitude`, `longitude` and `radius_km` (not both, and centre coordinates must be complete).')
);

// One tool, two audits against the local OSM staging store, selected by `check`.
// `limit`/`search_radius_m` apply to both; the remaining options are mode-specific
// (flagged in their descriptions) and simply ignored by the audit they don't apply to.
const auditLocationsArgs = v.object({
	check: v.pipe(
		v.picklist(['coordinate_drift', 'missing_address', 'duplicate_locations']),
		v.description(
			'Which audit to run:\n' +
				'• "coordinate_drift" — locations whose stored coordinates do NOT coincide with their ' +
				'OpenStreetMap POI. Each `drifted` entry carries the matched POI (`osm_url`, `osm_latitude`, ' +
				'`osm_longitude`, `distance_m`, `matched_osm_name`) — pass `osm_latitude`/`osm_longitude` to ' +
				'update_locations to snap it back, citing `osm_url`. Locations with no name-matching POI nearby ' +
				'are reported as `no_osm_match` (omit via include_unmatched=false).\n' +
				'• "missing_address" — locations whose stored address is empty (`reason: "missing"`) or, unless ' +
				'include_incomplete=false, a streetless fragment like a bare house number/postcode (`reason: ' +
				'"incomplete"`). Each entry is classified `osm_fix_available` (a nearby name-matching POI HAS an ' +
				'address — pass its `osm_address_parts` to update_locations, or split the `osm_address` preview ' +
				'when parts are absent, and cite `osm_url`), `osm_has_no_address`, or `no_osm_match`. Set ' +
				'include_unfixable=false for just the OSM-fixable work list.\n' +
				'• "duplicate_locations" — pairs of live locations within `radius_m` (default 150) whose names ' +
				'match or that share a brand: probably ONE venue stored twice (OSM sometimes carries two stale ' +
				"nodes for one place — coordinate-exact dedup cannot catch that). Each pair carries both halves' " +
				'phone/website/postcode, a `same_phone` flag (a shared phone ≈ the same store) and a `confidence` ' +
				'classification: "high" (name match within ~30 m, or shared phone) vs "review". Nearest pairs ' +
				"first; scope a post-import sweep with `brand_id`. Verify each against the venue's own store " +
				'locator before delete_location — two real branches CAN sit close together.'
		)
	),
	radius_m: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1000),
			v.description('[duplicate_locations only] Pair-flagging distance in metres (default 150).')
		)
	),
	brand_id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description(
				'[duplicate_locations only] Only pairs where at least one half belongs to this chain — scopes ' +
					'a post-import sweep to the chain just imported.'
			)
		)
	),
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
				'How far to look for a name-matching OSM POI before reporting no match (default 250). A ' +
					'location is OSM-sourced, so its source POI sits ~0 m away; widen to hunt relocated matches, ' +
					'but then check distance_m — a far match may be a different branch.'
			)
		)
	),
	tolerance_m: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.description(
				'[coordinate_drift only] A location counts as OSM-aligned when a name-matching POI sits ' +
					'within this many metres (default 1).'
			)
		)
	),
	include_unmatched: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'[coordinate_drift only] Also report locations with no name-matching OSM POI nearby (default true).'
			)
		)
	),
	include_incomplete: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'[missing_address only] Also flag locations whose stored address is a streetless fragment — a ' +
					'bare house number or postcode with no letter (e.g. "31", "90210") — not just empty ones (default true).'
			)
		)
	),
	include_unfixable: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'[missing_address only] Include locations OSM cannot fix (osm_has_no_address, no_osm_match) in ' +
					'the list; they are always counted regardless. Set false for just the actionable, OSM-fixable ' +
					'work list (default true).'
			)
		)
	)
});

const markNotDuplicateArgs = v.pipe(
	v.object({
		location_id_a: v.pipe(
			v.string(),
			v.minLength(1),
			v.description('One half of the flagged pair (order does not matter).')
		),
		location_id_b: v.pipe(
			v.string(),
			v.minLength(1),
			v.description('The other half of the flagged pair.')
		),
		reason: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					'The verification evidence, stored on the verdict — e.g. "both branches listed separately ' +
						'on restaurants.subway.com with distinct phone numbers". Required unless `revoke` is true.'
				)
			)
		),
		revoke: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Set true to WITHDRAW a previous verdict — the pair shows up in duplicate audits again.'
				)
			)
		)
	}),
	v.check(
		(input) => input.location_id_a !== input.location_id_b,
		'location_id_a and location_id_b must be two different locations.'
	),
	v.check(
		(input) => Boolean(input.revoke) || Boolean(input.reason?.trim()),
		'A `reason` (the verification evidence) is required when recording a verdict.'
	)
);

// --- Chains: brands, menus, menu items, per-location overrides ---

// Written at research time, read before ANY re-verification — re-discovering how
// to fetch a chain's menu (finding the API behind a client-rendered page) is the
// dominant cost of a refresh, and this is where that knowledge is banked.
const REFRESH_NOTES_DESC =
	"HOW to refresh this menu's data, banked for the next verification pass: the machine-readable " +
	'feed endpoint (ordering API, nutrition PDF, CMS query) plus fetch caveats — e.g. "menu page is ' +
	'client-rendered; use https://www.starbucks.ca/apiproxy/v1/ordering/menu (unauthenticated JSON)". ' +
	'RECORD it whenever menu research discovers a non-obvious source; CHECK it (get_menu) before ' +
	're-researching a menu from scratch.';

const createBrandArgs = v.object({
	name: v.pipe(
		v.string(),
		v.minLength(1),
		v.description('Chain / brand name, e.g. "McDonald\'s".')
	),
	website: v.optional(v.nullable(websiteSchema)),
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
	website: v.optional(v.nullable(websiteSchema)),
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
	currency: v.optional(currencySchema),
	// last_verified is not accepted: it is auto-stamped to today on every write.
	refresh_notes: v.optional(v.nullable(v.pipe(v.string(), v.description(REFRESH_NOTES_DESC)))),
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
	currency: v.optional(currencySchema),
	// last_verified is not accepted: any update re-stamps it to today automatically.
	refresh_notes: v.optional(
		v.nullable(v.pipe(v.string(), v.description(REFRESH_NOTES_DESC + ' Pass null to clear.')))
	),
	sources: updateSourcesSchema,
	add_sources: addSourcesSchema
});

const listMenusArgs = v.object({
	brand_id: v.optional(
		v.pipe(v.string(), v.minLength(1), v.description('Only list menus belonging to this brand.'))
	)
});

const getMenuArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('The record id (UUID).')),
	view: v.optional(
		v.pipe(
			v.picklist(['full', 'names', 'summary']),
			v.description(
				'Payload size: "full" (default) — complete items; "names" — id/name/price/tag-ids per item; ' +
					'"summary" — no item list, just counts and a tag histogram. Prefer names/summary for audits ' +
					'and menu-wide scans.'
			)
		)
	)
});

// One item patch within an update_items batch. Every field but `id` is optional;
// only the fields present are changed.
const updateItemArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('Id of the item to update.')),
	menu_id: v.optional(
		v.pipe(v.string(), v.minLength(1), v.description('Move the item to a different menu (rare).'))
	),
	item_name: v.optional(v.pipe(v.string(), v.minLength(1))),
	description: v.optional(v.nullable(v.string())),
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
	sources: updateSourcesSchema,
	add_sources: addSourcesSchema
});

const updateItemsArgs = v.object({
	items: v.pipe(
		v.array(updateItemArgs),
		v.minLength(1),
		v.maxLength(200),
		v.description(
			'Item patches to apply in one atomic batch — pass a single item to edit one. Each carries ' +
				'an `id` plus only the fields to change. Editing a shared chain item changes it for every ' +
				'branch serving its menu — for a one-branch difference use set_location_item_override instead. ' +
				'Ids that do not exist are reported in `not_found_ids` rather than failing the batch.'
		)
	)
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
				v.description(
					'false = not served at this branch; null = reset to inherit (served); omit = keep the ' +
						'current stored value.'
				)
			)
		)
	),
	price: v.optional(
		v.nullable(
			v.pipe(
				priceSchema,
				v.description(
					'Price at this branch; null = reset to inherit the menu price; omit = keep the current ' +
						'stored value.'
				)
			)
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
//     set_location_item_override is a PARTIAL patch (an omitted field keeps its stored
//     value), but it is still marked destructive because it overwrites existing override data.
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
 * Guards the mutually-exclusive `sources` (replace) vs `add_sources` (append) update
 * options: an agent must pick one, since replacing and appending in the same call is
 * ambiguous. `label` identifies the record in the error (e.g. an id) for batch tools.
 */
function assertSourcesNotBoth(sources: unknown, addSources: unknown, label?: string): void {
	if (sources !== undefined && addSources !== undefined) {
		throw new Error(
			`${label ? `"${label}": ` : ''}pass either \`sources\` (replace the whole set) or ` +
				'`add_sources` (append), not both.'
		);
	}
}

type CreateLocationItem = v.InferOutput<typeof createLocationArgs>;

/** One item that failed to resolve in a skip_invalid batch (or a combined error). */
interface SkippedInvalid {
	name: string;
	osm_id?: string;
	reason: string;
}

/** What {@link createLocationsBatch} returns — the create_locations result shape. */
interface CreateLocationsResult {
	created: number;
	location_ids: string[];
	items_created: number;
	item_ids: string[];
	skipped_existing_ids: string[];
	skipped_duplicate_locations?: { name: string; existing_id: string | null }[];
	skipped_invalid?: SkippedInvalid[];
	warnings?: string[];
}

/** Two same-name venues within this distance are flagged as likely duplicates. */
const NEAR_DUPLICATE_M = 150;

/**
 * Warnings for new points that sit suspiciously close to a SAME-NAME venue —
 * either one already on the map, or another item in this very batch (OSM itself
 * sometimes carries two stale nodes for one venue; coordinate-exact dedup cannot
 * catch those, so they surface here for a human/agent decision instead of
 * silently landing as two pins).
 */
async function nearDuplicateWarnings(
	toInsert: { it: CreateLocationItem; core: ResolvedLocationCore }[]
): Promise<string[]> {
	if (!toInsert.length) return [];
	// One covering box for the whole batch, padded past NEAR_DUPLICATE_M; exact
	// distance + name matching refine below.
	const lats = toInsert.map(({ core }) => core.latitude);
	const lons = toInsert.map(({ core }) => core.longitude);
	const worstLat = Math.max(...lats.map(Math.abs));
	const pad = bboxAround(worstLat, 0, NEAR_DUPLICATE_M / 1000);
	const padLat = pad.maxLat - worstLat; // degrees covering the threshold in latitude
	const padLon = pad.maxLng; // and in longitude at the batch's worst latitude (centre lng 0)
	const existing = await openLocationsInBbox(getDb(), {
		minLat: Math.min(...lats) - padLat,
		maxLat: Math.max(...lats) + padLat,
		minLng: Math.min(...lons) - padLon,
		maxLng: Math.max(...lons) + padLon
	});
	const warnings: string[] = [];
	toInsert.forEach(({ it, core }, i) => {
		const name = normalizeName(it.name);
		for (const loc of existing) {
			const d = haversineMeters(core.latitude, core.longitude, loc.latitude, loc.longitude);
			if (d > 0 && d <= NEAR_DUPLICATE_M && namesMatch(name, normalizeName(loc.name))) {
				warnings.push(
					`"${it.name}"${it.osm_id ? ` (${it.osm_id})` : ''} was created ${Math.round(d)} m from ` +
						`existing same-name location ${loc.id} — possibly the same venue mapped twice in OSM. ` +
						`Verify (e.g. against the chain's own store locator) and delete_location the duplicate row.`
				);
				break;
			}
		}
		for (let j = i + 1; j < toInsert.length; j++) {
			const other = toInsert[j];
			const d = haversineMeters(
				core.latitude,
				core.longitude,
				other.core.latitude,
				other.core.longitude
			);
			if (d <= NEAR_DUPLICATE_M && namesMatch(name, normalizeName(other.it.name))) {
				warnings.push(
					`"${it.name}"${it.osm_id ? ` (${it.osm_id})` : ''} and "${other.it.name}"` +
						`${other.it.osm_id ? ` (${other.it.osm_id})` : ''} in this batch are only ` +
						`${Math.round(d)} m apart — possibly one venue carried twice in OSM. Verify and ` +
						`delete_location the duplicate row.`
				);
			}
		}
	});
	return warnings;
}

/**
 * The create_locations core, shared with import_chain: validates chain refs,
 * skips already-created ids, resolves coordinates/addresses (collecting EVERY
 * failure rather than dying on the first), de-dups by exact coordinates, warns
 * about near-duplicates, and inserts the remainder atomically.
 */
async function createLocationsBatch(
	items: CreateLocationItem[],
	opts: { skipInvalid?: boolean } = {}
): Promise<CreateLocationsResult> {
	// Validate each DISTINCT brand/menu pair once — a chain backfill reuses a
	// single pair across the whole batch, so this is usually one check.
	const checkedPairs = new Set<string>();
	for (const it of items) {
		const key = `${it.brand_id ?? ''}|${it.menu_id ?? ''}`;
		if (checkedPairs.has(key)) continue;
		checkedPairs.add(key);
		await assertBrandMenuRefs(getDb(), it.brand_id, it.menu_id);
	}
	// Idempotency: skip items whose explicit id already exists, so retrying a batch
	// that already landed is a no-op rather than a primary-key collision.
	const explicitIds = items.map((it) => it.id).filter((id): id is string => Boolean(id));
	const already = explicitIds.length
		? await existingIds(getDb(), 'locations', explicitIds)
		: new Set<string>();
	const skippedExistingIds: string[] = [];
	const afterIdSkip = items.filter((it) => {
		if (it.id && already.has(it.id)) {
			skippedExistingIds.push(it.id);
			return false;
		}
		return true;
	});
	// Resolve coordinates + address for each survivor (also rejects an inline-items /
	// chain-link conflict), collecting every failure so ONE round-trip surfaces all
	// of them — under skip_invalid the failures are reported per-row instead.
	const warnings: string[] = [];
	const skippedInvalid: SkippedInvalid[] = [];
	const resolved: { it: CreateLocationItem; core: ResolvedLocationCore }[] = [];
	for (const it of afterIdSkip) {
		try {
			if (it.menu_items?.length && (it.brand_id || it.menu_id)) {
				throw new Error(
					`has \`menu_items\` but is linked to a chain (brand_id/menu_id). Inline items ` +
						`are for an independent venue's own menu; a chain branch shares its menu — use ` +
						`create_items with the menu_id, or set_location_item_override for a per-branch delta.`
				);
			}
			if (it.closed_reason && it.menu_items?.length) {
				throw new Error(
					`has both \`closed_reason\` and \`menu_items\` — a permanently-closed venue has ` +
						`no menu. Drop the items to file it as a closed tombstone, or drop closed_reason to add it live.`
				);
			}
			const warn = (message: string): void => {
				warnings.push(`"${it.name}"${it.osm_id ? ` (${it.osm_id})` : ''}: ${message}`);
			};
			resolved.push({ it, core: resolveLocationInsertCore(it, warn) });
		} catch (err) {
			skippedInvalid.push({
				name: it.name,
				...(it.osm_id ? { osm_id: it.osm_id } : {}),
				reason: err instanceof Error ? err.message : String(err)
			});
		}
	}
	if (skippedInvalid.length && !opts.skipInvalid) {
		const shown = skippedInvalid.slice(0, 15);
		throw new Error(
			`${skippedInvalid.length} of ${items.length} item(s) are invalid — nothing was written ` +
				`(pass skip_invalid: true to create the valid ones and get these reported per-row):\n` +
				shown
					.map((s) => `• "${s.name}"${s.osm_id ? ` (${s.osm_id})` : ''}: ${s.reason}`)
					.join('\n') +
				(skippedInvalid.length > shown.length
					? `\n… and ${skippedInvalid.length - shown.length} more.`
					: '')
		);
	}
	// Coordinate-exact de-dup: a location already on the map (OSM coords are stored
	// verbatim, so a true duplicate is coordinate-identical), or a point repeated
	// earlier in THIS batch, is skipped rather than creating a duplicate pin.
	const existingAtCoords = await existingLocationsAtCoords(
		getDb(),
		resolved.map(({ core }) => ({ latitude: core.latitude, longitude: core.longitude }))
	);
	const skippedDuplicateLocations: { name: string; existing_id: string | null }[] = [];
	const seenCoords = new Set<string>();
	const toInsert = resolved.filter(({ it, core }) => {
		const key = coordinateKey(core.latitude, core.longitude);
		const onMap = existingAtCoords.get(key);
		if (onMap) {
			skippedDuplicateLocations.push({ name: it.name, existing_id: onMap.id });
			return false;
		}
		if (seenCoords.has(key)) {
			// Duplicate of an earlier item in this same batch (no id yet → null).
			skippedDuplicateLocations.push({ name: it.name, existing_id: null });
			return false;
		}
		seenCoords.add(key);
		return true;
	});
	warnings.push(...(await nearDuplicateWarnings(toInsert)));
	// Pre-assign ids to any inline menu_items so we can return them; the location,
	// its private menu and these items all land in the one atomic batch.
	const itemIds: string[] = [];
	const inserts = toInsert.map(({ it, core }) => {
		const menuItems = (it.menu_items ?? []).map((mi) => {
			const id = mi.id ?? crypto.randomUUID();
			itemIds.push(id);
			return {
				id,
				item_name: mi.item_name,
				description: mi.description ?? null,
				price: mi.price ?? null,
				tags: mi.tags,
				optionalTags: mi.optional_tags,
				sources: normalizeSources(mi.sources)
			};
		});
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
			currency: it.currency,
			sources: core.sources,
			// A born-closed tombstone: stamp closed_at now so it's hidden from the map yet
			// still blocks re-creation / search_poi re-suggestion (migration 0015).
			...(it.closed_reason ? { closed_at: Date.now(), closed_reason: it.closed_reason } : {}),
			...(menuItems.length ? { items: menuItems } : {})
		};
	});
	const ids = inserts.length ? await insertLocations(getDb(), inserts) : [];
	return {
		created: ids.length,
		location_ids: ids,
		items_created: itemIds.length,
		item_ids: itemIds,
		skipped_existing_ids: skippedExistingIds,
		...(skippedDuplicateLocations.length
			? { skipped_duplicate_locations: skippedDuplicateLocations }
			: {}),
		...(skippedInvalid.length ? { skipped_invalid: skippedInvalid } : {}),
		...(warnings.length ? { warnings } : {})
	};
}

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
 * to the POI's best available parts — its own addr:* tags, then the enriched
 * address line (containing building / Overture), then the extract-time
 * admin-boundary city/region — with any caller-supplied part overriding. Without
 * `osm_id`, latitude/longitude and street/city/region are required and used as
 * given. Throws an MCP-friendly error on unresolved or conflicting input;
 * non-fatal oddities (a dropped partial postcode) go through `warn`.
 */
function resolveLocationInsertCore(
	it: CreateLocationItem,
	warn: (message: string) => void
): ResolvedLocationCore {
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
		// Caller-supplied parts override the POI's merged parts; absent parts fall
		// back to the POI. (`??` means a caller can't blank a POI-derived part — there's
		// no reason to import a venue and then strip its address, so that's intended.)
		const poiParts = effectivePoiAddressParts(poi) ?? {};
		const street = it.street ?? poiParts.street;
		const city = it.city ?? poiParts.city;
		const region = it.region ?? poiParts.region;
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
					`addr:* tags, enrichment feeds or admin-boundary context — pass ${missing.join(', ')} ` +
					`explicitly (from the venue's own source; never geocode).`
			);
		}
		const addr = normalizeAddressParts(
			{
				street: street as string,
				city: city as string,
				region: region as string,
				postcode: it.postcode ?? poiParts.postcode ?? null,
				country: it.country ?? poiParts.country ?? null
			},
			warn
		);
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
		...normalizeAddressParts(
			{
				street: it.street,
				city: it.city,
				region: it.region,
				postcode: it.postcode,
				country: it.country
			},
			warn
		),
		sources
	};
}

/** Lightweight location overview, returned by list_locations. */
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
	brandId?: string;
	limit?: number;
	offset?: number;
}) {
	const { near, category, nameLike, brandId, limit, offset } = opts;
	if (near) {
		const rows = await getLocationsWithTags(getDb(), {
			bbox: bboxAround(near.latitude, near.longitude, near.radius_km),
			category,
			nameLike,
			brandId
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
	const rows = await getLocationsWithTags(getDb(), { category, nameLike, brandId, limit, offset });
	return rows.map(projectLocationOverview);
}

/**
 * Strips the menu-level fields (`menu_id`, `currency`) from an item returned INSIDE
 * its parent menu/location, which carries them once already — so a 100-item menu
 * doesn't repeat `"currency":"CAD"` and the same `menu_id` on every item. A
 * standalone get_item keeps them (it has no parent context to read them from).
 */
function itemWithinParent({
	menu_id: _menu_id,
	currency: _currency,
	...rest
}: Item): Omit<Item, 'menu_id' | 'currency'> {
	return rest;
}

const tools = [
	defineTool({
		name: 'list_locations',
		annotations: READ_ONLY,
		description:
			'List locations in the LIVE map database as a lightweight overview — id, name, category, ' +
			'coordinates, address, phone, website, brand_id/menu_id (set for chain branches), and the distinct ' +
			'tag ids offered across the effective menu (no per-item detail, no source URLs). Pass `query` to ' +
			'match by name (case-insensitive substring) — e.g. to check whether a venue is already on the map ' +
			'(de-dup before adding) or to find one to edit; this reads the live D1, distinct from search_poi ' +
			'which finds OSM venues NOT yet on the map. Narrow with `near`/`category`/`brand_id` (exact chain ' +
			'membership — better than a name substring for enumerating branches), page with `limit`/`offset`, ' +
			'or pass `count_only: true` for just the matching total (cheap chain-size audits). Use ' +
			'get_location for a single place with its full menu and sources.',
		schema: listLocationsArgs,
		handler: async ({ query, near, category, brand_id, count_only, limit, offset }) => {
			if (count_only) {
				// `near` counts refine to the exact circle via the same query path.
				if (near) {
					const rows = await queryLocations({ near, category, nameLike: query, brandId: brand_id });
					return { count: rows.length };
				}
				return {
					count: await countLocations(getDb(), { category, nameLike: query, brandId: brand_id })
				};
			}
			return queryLocations({ near, category, nameLike: query, brandId: brand_id, limit, offset });
		}
	}),
	defineTool({
		name: 'get_location',
		annotations: READ_ONLY,
		description:
			'Get a single location with its source URLs. `menu` lists only the items owned directly by this ' +
			'venue (on its own private menu); each item omits the menu-level `currency`/`menu_id`, surfaced ' +
			'once as the top-level `currency` (the venue serves one private menu). If `menu_id` is a shared ' +
			'brand menu the location is a chain branch — call get_menu to see/edit those items; `overrides` ' +
			"lists this branch's per-item deviations from them. Returns null if not found.",
		schema: idArgs,
		handler: async ({ id }) => {
			const location = await getLocationById(getDb(), id);
			if (!location) return null;
			const [menu, overrides] = await Promise.all([
				getFoodByLocation(getDb(), id),
				getLocationItemOverrides(getDb(), id)
			]);
			// An independent venue's items all live on one private menu, so the menu-level
			// currency/menu_id are identical across them: surface currency once at the top
			// and drop the per-item copies (see itemWithinParent).
			const currency = menu[0]?.currency;
			return {
				...location,
				...(currency ? { currency } : {}),
				menu: menu.map(itemWithinParent),
				overrides
			};
		}
	}),
	defineTool({
		name: 'create_locations',
		annotations: CREATE,
		description:
			'Create one or more locations in a single batch — the only way to add ' +
			"locations; pass a one-item `items` array for a single place. PREFERRED: set each item's " +
			'`osm_id` from a search_poi candidate (see the `osm_id` field doc) so coordinates + address come ' +
			'from OSM verbatim; otherwise pass latitude/longitude + a structured address (street/city/region/' +
			'country required, postcode optional; region/postcode/country are normalized, e.g. "Ontario" → ' +
			'"ON"). `name` is the venue\'s own name ONLY — never bake a branch\'s location (street/' +
			'neighbourhood/mall/landmark) or an editorial annotation (former name, status note) into it; ' +
			'branches share a name and are told apart by address (see the `name` field doc). For a chain branch set `menu_id`/`brand_id`; for an independent venue omit them and ' +
			'optionally pass `menu_items` to create its private menu in the same batch (else use create_items). ' +
			'(To import a whole chain from the OSM staging store, prefer import_chain.) ' +
			'Idempotent on explicit ids (skipped → `skipped_existing_ids`; give an inline-`menu_items` location ' +
			'an explicit id too, so its items skip with it) and coordinate-deduped against the map and earlier ' +
			'batch items (skipped → `skipped_duplicate_locations`), so retries/re-imports are safe. By default ' +
			'any invalid item fails the whole batch with EVERY failing item listed (nothing written); with ' +
			'`skip_invalid: true` the valid items are created and the failures come back in `skipped_invalid`. ' +
			'Returns { created, location_ids, items_created, item_ids, skipped_existing_ids, ' +
			'skipped_duplicate_locations, skipped_invalid, warnings } — `warnings` flags dropped partial ' +
			'postcodes and same-name venues within ~150 m (possible OSM double-mapping worth verifying); ' +
			'fetch details with get_location if needed.',
		schema: createLocationsArgs,
		handler: ({ items, skip_invalid }) => createLocationsBatch(items, { skipInvalid: skip_invalid })
	}),
	defineTool({
		name: 'update_locations',
		annotations: DESTRUCTIVE,
		description:
			'Update one or more existing locations in a single atomic batch — pass a one-item `items` array to ' +
			'edit one place. Each patch carries an `id` plus only the fields to change; a given `sources` array ' +
			"replaces that location's whole source set (pass [] to clear), or use `add_sources` to append a " +
			'citation without resending the rest. Set `menu_id`/`brand_id` (together) to attach a ' +
			'branch to a chain menu, or null to detach it. region/postcode/country are normalized for you. ' +
			'Ideal for mass backfills from audit_locations. Ids that do not exist ' +
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
				await assertBrandMenuRefs(getDb(), it.brand_id, it.menu_id);
			}
			const patches = items.map(
				({ id, sources, add_sources, street, city, region, postcode, country, ...patch }) => {
					assertSourcesNotBoth(sources, add_sources, id);
					return {
						id,
						...patch,
						...normalizeAddressPatch({ street, city, region, postcode, country }),
						sources: normalizeSources(sources),
						addSources: normalizeSources(add_sources)
					};
				}
			);
			const { updatedIds, notFoundIds } = await updateLocations(getDb(), patches);
			return { updated: updatedIds.length, updated_ids: updatedIds, not_found_ids: notFoundIds };
		}
	}),
	defineTool({
		name: 'delete_location',
		annotations: DESTRUCTIVE,
		description:
			'HARD-delete a location row. Cascades its sources, per-item overrides, and any user LIKES of the ' +
			'venue (liked_locations); its private menu + items are left orphaned, not removed. Returns ' +
			'{ deleted: true } if a row was removed. Prefer close_location for a venue that has permanently ' +
			'closed — that preserves the likes and keeps the record for analysis; reserve delete_location for ' +
			'a mistaken/duplicate row that should never have existed.',
		schema: idArgs,
		handler: async ({ id }) => ({ deleted: await deleteLocation(getDb(), id) })
	}),
	defineTool({
		name: 'close_location',
		annotations: DESTRUCTIVE,
		description:
			'Mark a location that is ALREADY on the map as PERMANENTLY CLOSED (soft-delete), or reopen one. ' +
			'The row is kept — so its user likes, menu and sources survive for analysis — and simply hidden ' +
			'from the map, search, list_locations, get_location and the coverage stats; it still blocks ' +
			're-creation and search_poi re-suggestion, so a closed venue never resurfaces to waste research ' +
			'time. Pass `reason` (closure evidence) and optionally `sources` to cite it; pass `reopen: true` ' +
			'to bring it back. Returns { closed: true } / { reopened: true }, or { not_found: true } if no ' +
			'such id. For a venue NOT yet on the map that you have verified is closed, use create_locations ' +
			'with `closed_reason` instead (a born-closed tombstone) rather than adding it and closing it.',
		schema: closeLocationArgs,
		handler: async ({ id, reason, reopen, sources }) => {
			const ok = reopen
				? await setLocationClosed(getDb(), id, null, null)
				: await setLocationClosed(
						getDb(),
						id,
						Date.now(),
						reason ?? null,
						normalizeSources(sources)
					);
			if (!ok) return { closed: false, not_found: true, id };
			return reopen ? { reopened: true, id } : { closed: true, id };
		}
	}),
	defineTool({
		name: 'create_items',
		annotations: CREATE,
		description:
			'Create one or more menu items in a single transaction (all-or-nothing): if any item is invalid, ' +
			'none are written. Target EITHER an independent venue (pass `location_id` — items go on its own ' +
			'private menu, created on first use) OR a shared brand menu (pass `menu_id` — items appear at every ' +
			'branch serving it); pass exactly one. Pass a one-element `items` array to add a single item. Tip: ' +
			'when creating the venue too, pass the items inline as `menu_items` on create_locations to do it in ' +
			'one call. Returns { created, item_ids, skipped_existing_ids, name_collisions } — ids already present ' +
			'are skipped (retries are safe); `name_collisions` lists incoming names that already exist on the ' +
			'target menu so you can update the existing item instead of duplicating it. Read full items with ' +
			'get_item / get_location / get_menu if needed.',
		schema: createItemsArgs,
		handler: async (input) => {
			// Resolve the target menu: an independent venue's private menu (location_id), or a
			// shared brand menu (menu_id). The schema guarantees exactly one is set.
			let menuIdForCollisions: string | null;
			if (input.location_id !== undefined) {
				const location = await getLocationById(getDb(), input.location_id);
				if (!location) throw new Error(`No location with id "${input.location_id}".`);
				// A chain branch shares a menu and has no private item store; insertFoods rejects
				// it. Its existing menu_id is what new items would collide against.
				menuIdForCollisions = location.menu_id;
			} else {
				if (!(await getMenuById(getDb(), input.menu_id as string))) {
					throw new Error(`No menu with id "${input.menu_id}".`);
				}
				menuIdForCollisions = input.menu_id as string;
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
			// Name-collision check runs BEFORE the insert (against the target menu, if any)
			// so the items being added don't match themselves.
			const nameCollisions = menuIdForCollisions
				? await itemNameCollisions(
						getDb(),
						menuIdForCollisions,
						toInsert.map((it) => it.item_name)
					)
				: [];
			let ids: string[] = [];
			if (toInsert.length) {
				ids =
					input.location_id !== undefined
						? await insertFoods(
								getDb(),
								toInsert.map((it) => ({
									id: it.id,
									location_id: input.location_id as string,
									item_name: it.item_name,
									description: it.description ?? null,
									price: it.price ?? null,
									tags: it.tags,
									optionalTags: it.optional_tags,
									sources: normalizeSources(it.sources)
								})),
								input.currency
							)
						: await insertMenuItems(
								getDb(),
								toInsert.map((it) => ({
									id: it.id,
									menu_id: input.menu_id as string,
									item_name: it.item_name,
									description: it.description ?? null,
									price: it.price ?? null,
									tags: it.tags,
									optionalTags: it.optional_tags,
									sources: normalizeSources(it.sources)
								}))
							);
			}
			return {
				created: ids.length,
				item_ids: ids,
				skipped_existing_ids: skippedExistingIds,
				...(nameCollisions.length ? { name_collisions: nameCollisions } : {})
			};
		}
	}),
	defineTool({
		name: 'get_item',
		annotations: READ_ONLY,
		description:
			"Get any menu item by id — a venue's own item or a chain's shared one — with its tags " +
			"(dietary, course) and source URLs. To browse a venue's items use get_location; " +
			'for a chain menu use get_menu. Returns null if not found.',
		schema: idArgs,
		handler: async ({ id }) => getItemById(getDb(), id)
	}),
	defineTool({
		name: 'update_items',
		annotations: DESTRUCTIVE,
		description:
			'Update one or more menu items by id in a single atomic batch — pass a one-item `items` array to ' +
			'edit one. Each patch carries an `id` plus only the fields to change; editing a shared chain item ' +
			'changes it for EVERY branch serving its menu — for a one-branch difference use ' +
			'set_location_item_override instead. Replace-set semantics per item: `tags`/`optional_tags` ' +
			'together replace the dietary/course set; `sources` replaces sources (pass []/"" to clear) ' +
			'while `add_sources` appends without resending the rest (not both). Ideal for menu-wide ' +
			'corrections in one call. Ids that do not exist are reported in `not_found_ids`. ' +
			'Returns { updated, updated_ids, not_found_ids }.',
		schema: updateItemsArgs,
		handler: async ({ items }) => {
			const patches = items.map(({ id, sources, add_sources, optional_tags, ...patch }) => {
				assertSourcesNotBoth(sources, add_sources, id);
				return {
					id,
					...patch,
					optionalTags: optional_tags,
					sources: normalizeSources(sources),
					addSources: normalizeSources(add_sources)
				};
			});
			const { updatedIds, notFoundIds } = await updateItems(getDb(), patches);
			return {
				updated: updatedIds.length,
				updated_ids: updatedIds,
				not_found_ids: notFoundIds
			};
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
			// Flag (don't block) a same-name brand so an accidental duplicate is visible.
			const dupIds = await findBrandIdsByName(getDb(), input.name);
			const id = await insertBrand(getDb(), {
				id: input.id,
				name: input.name,
				website: input.website ?? null,
				logo_url: input.logo_url ?? null
			});
			const warnings = dupIds.length
				? [
						`A brand named "${input.name}" already exists (id ${dupIds.join(', ')}). Created a new ` +
							`brand (${id}) anyway — if this is the same chain, delete it and reuse the existing brand.`
					]
				: [];
			return { id, already_existed: false, ...(warnings.length ? { warnings } : {}) };
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
			'Get a brand plus its menus as summaries (id, name, region, currency, last_verified, item_count, ' +
			"location_count = open branches serving it). Call get_menu for a menu's items. Returns null if not found.",
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
			'Create a regional menu under a brand (e.g. name "Subway UK", region "GB", currency "GBP"). Add its ' +
			'shared items with create_items (using this menu_id), then point each branch at it via ' +
			'location.menu_id. Set ' +
			`\`currency\` so item prices are unambiguous (defaults to ${DEFAULT_CURRENCY}). Optionally cite the ` +
			'official menu once via `sources`, and bank HOW to re-fetch it in `refresh_notes` (feed ' +
			"endpoint + caveats) so the next verification skips source re-discovery. The menu's freshness " +
			'date (last_verified) is set automatically to today here and on every later write — never pass ' +
			'it. Returns { id } — read it back with get_menu.',
		schema: createMenuArgs,
		handler: async (input) => {
			if (!(await getBrandById(getDb(), input.brand_id))) {
				throw new Error(`No brand with id "${input.brand_id}".`);
			}
			// Idempotent on an explicit id: a retry that already created the menu is a no-op.
			if (input.id && (await getMenuById(getDb(), input.id))) {
				return { id: input.id, already_existed: true };
			}
			// Flag (don't block) a same-name menu under this brand as a likely duplicate.
			const dupIds = await findMenuIdsByName(getDb(), input.brand_id, input.name);
			const id = await insertMenu(getDb(), {
				id: input.id,
				brand_id: input.brand_id,
				name: input.name,
				region: input.region ?? null,
				currency: input.currency,
				refresh_notes: input.refresh_notes ?? null,
				sources: normalizeSources(input.sources)
			});
			const warnings = dupIds.length
				? [
						`A menu named "${input.name}" already exists under this brand (id ${dupIds.join(', ')}). ` +
							`Created a new menu (${id}) anyway — reuse the existing one if this is a duplicate.`
					]
				: [];
			return { id, already_existed: false, ...(warnings.length ? { warnings } : {}) };
		}
	}),
	defineTool({
		name: 'list_menus',
		annotations: READ_ONLY,
		description:
			'List menus (id, brand_id, name, region, currency, last_verified, item_count, location_count = ' +
			"open branches serving it), optionally filtered to one brand. Use get_menu for a menu's items.",
		schema: listMenusArgs,
		handler: ({ brand_id }) => getMenus(getDb(), brand_id)
	}),
	defineTool({
		name: 'get_menu',
		annotations: READ_ONLY,
		description:
			"Get a menu with its own source URLs and `refresh_notes` (HOW to re-fetch the menu's source — " +
			'read these before re-researching a menu from scratch). `view` picks the payload size: "full" (default) — ' +
			'every item with tags, description, price and sources; "names" — items as just { id, item_name, ' +
			'price, tags } (menu-wide edits/scans without the prose); "summary" — no item list, just counts ' +
			'(item_count, a per-tag histogram, how many items have a price / a source). A 100-item chain menu ' +
			'is a large payload in full view — prefer summary/names for audits. Each full-view item omits the ' +
			'menu-level `currency`/`menu_id`, which the menu itself carries once. Returns null if not found.',
		schema: getMenuArgs,
		handler: async ({ id, view }) => {
			const menu = await getMenuWithItems(getDb(), id);
			if (!menu) return null;
			if (view === 'summary') {
				const tagCounts: Record<string, number> = {};
				let priced = 0;
				let sourced = 0;
				for (const item of menu.items) {
					if (item.price !== null) priced++;
					if (item.sources.length) sourced++;
					for (const tag of item.tags) {
						tagCounts[tag.id] = (tagCounts[tag.id] ?? 0) + 1;
					}
				}
				const { items, ...meta } = menu;
				return {
					...meta,
					item_count: items.length,
					items_with_price: priced,
					items_with_sources: sourced,
					tag_counts: tagCounts
				};
			}
			if (view === 'names') {
				return {
					...menu,
					items: menu.items.map((item) => ({
						id: item.id,
						item_name: item.item_name,
						price: item.price,
						tags: item.tags.map((t) => (t.optional ? `${t.id} (optional)` : t.id))
					}))
				};
			}
			// The menu already carries its id + currency; drop the identical per-item copies.
			return { ...menu, items: menu.items.map(itemWithinParent) };
		}
	}),
	defineTool({
		name: 'update_menu',
		annotations: DESTRUCTIVE,
		description:
			'Update a menu (including its `currency` and `refresh_notes` — bank a newly discovered feed ' +
			'endpoint here). Only provided fields change; if `sources` is given it ' +
			'replaces the whole source set (pass [] to clear), or use `add_sources` to append one. Any update ' +
			"also refreshes the menu's `last_verified` date to today automatically. Returns the updated menu, " +
			'or null if the id does not exist.',
		schema: updateMenuArgs,
		handler: async ({ id, sources, add_sources, ...patch }) => {
			assertSourcesNotBoth(sources, add_sources, id);
			if (patch.brand_id && !(await getBrandById(getDb(), patch.brand_id))) {
				throw new Error(`No brand with id "${patch.brand_id}".`);
			}
			return updateMenu(getDb(), id, {
				...patch,
				sources: normalizeSources(sources),
				addSources: normalizeSources(add_sources)
			});
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
		name: 'set_location_item_override',
		annotations: DESTRUCTIVE,
		description:
			'Record how ONE branch differs from its shared menu for ONE item: available=false hides the item ' +
			'at that branch; price overrides it there. This is a PARTIAL patch — a field you OMIT keeps its ' +
			'current stored value (so toggling just `available` never wipes a previously-set `price`); ' +
			'pass an explicit null for a field to reset it to inherit the menu default. Returns the resulting ' +
			'merged override. Prefer this over editing the shared item when only one branch differs.',
		schema: setOverrideArgs,
		handler: async ({ location_id, menu_item_id, available, price }) => {
			const result = await setLocationItemOverride(getDb(), location_id, menu_item_id, {
				available,
				price
			});
			return { location_id, menu_item_id, ...result };
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
			'phone/website/cuisine/opening_hours where tagged, and structured `address_parts` ' +
			"(the POI's own OSM tags, enrichment feeds, and admin-boundary city/region merged — exactly " +
			'what an import stores). Pass `compact: true` for large sweeps (minimal shape, fits 200 ' +
			'candidates well under output caps) and `exclude_osm_ids` to silence known false matches. ' +
			'If `scan_truncated` is true the box exceeded the internal scan cap: `total_in_area` is only a ' +
			'lower bound and re-sweeping the same box will NOT surface the uncounted POIs — narrow the bbox ' +
			'or lower radius_km until it clears. ' +
			"Workflow: call this, then pass each candidate's `osm_id` to create_locations to import it " +
			'(coordinates + address come from OSM verbatim, auto-cited) — or, for a chain, use ' +
			'import_chain to do the whole loop in one call.',
		schema: searchPoiArgs,
		handler: async (input) => {
			const db = input.exclude_existing === false ? null : getDb();
			const result = await searchPoi(getOsmStore(), db, {
				bbox: input.bbox ? toBounds(input.bbox) : undefined,
				latitude: input.latitude,
				longitude: input.longitude,
				radius_km: input.radius_km,
				category: input.category,
				name: input.name,
				cuisine: input.cuisine,
				country: input.country,
				exclude_existing: input.exclude_existing,
				exclude_osm_ids: input.exclude_osm_ids,
				limit: input.limit
			});
			if (!input.compact) return result;
			return {
				...result,
				candidates: result.candidates.map((c) => {
					const parts = c.address_parts;
					const has_address = !parts
						? 'none'
						: parts.street && parts.city && parts.region
							? 'full'
							: 'partial';
					return {
						osm_id: c.osm_id,
						name: c.name,
						suggested_category: c.suggested_category,
						latitude: c.latitude,
						longitude: c.longitude,
						has_address,
						...(c.distance_m === undefined ? {} : { distance_m: c.distance_m })
					};
				})
			};
		}
	}),
	defineTool({
		name: 'import_chain',
		annotations: CREATE,
		description:
			'Import EVERY branch of a chain from the OSM staging store in one call — the preferred way to ' +
			'add chain locations (it replaces the search_poi → filter → create_locations loop). Prerequisites: ' +
			'the brand, its shared menu and the menu items already exist (a non-dry-run import fails if the ' +
			'menu has no items). Given an area and the source names ' +
			'accepted as this chain (`name_match`, strict normalized equality), it scans the store, drops ' +
			'venues already on the map, and creates each remaining branch pointed at `brand_id`/`menu_id` — ' +
			'coordinates + structured address come from OSM verbatim per branch (own addr:* tags, enrichment ' +
			'feeds, admin-boundary city/region), each auto-citing its osm_url. Branches that still cannot ' +
			'resolve (e.g. no recoverable street) are reported in `skipped_invalid` with reasons, never ' +
			'silently dropped; `warnings` flags same-name branches within ~150 m (possible OSM double-mapping ' +
			"— verify against the chain's own locator before deleting). `name_buckets` histograms every POI " +
			'name seen in the area — each bucket annotated with its dominant OSM `brand:wikidata` QID — so ' +
			'you can vet variants and extend `name_match` (or pass `brand_wikidata` to accept brand-tagged ' +
			'variants automatically, and `country` to keep border-town POIs of a neighbouring country out); ' +
			're-runs are safe (already-imported branches are excluded). ALWAYS call with `dry_run: true` ' +
			'first to vet the allowlist. Returns { imported, location_ids, excluded_existing, ' +
			'excluded_foreign?, matched_by_brand?, skipped_duplicate_locations, skipped_invalid, warnings, ' +
			'name_buckets, remaining_beyond_max, scan_truncated }. If a D1 failure interrupts the import ' +
			'partway, the error reply still carries the committed partial state (`partial_failure: true` plus ' +
			'imported/warnings/skipped so far) — read its `warnings` before re-running, since committed ' +
			'branches count as excluded_existing on the re-run and those warnings never resurface.',
		schema: importChainArgs,
		handler: async (input) => {
			await assertBrandMenuRefs(getDb(), input.brand_id, input.menu_id);
			// The documented prerequisite ("brand, shared menu and menu items already
			// exist") is enforced here: importing hundreds of branches onto an empty
			// menu (a forgotten create_items) would put menu-less venues on the map.
			if (!input.dry_run && (await countMenuItems(getDb(), input.menu_id)) === 0) {
				throw new Error(
					`Menu "${input.menu_id}" has no items yet — add the chain's shared items with ` +
						`create_items (menu_id) before importing branches, or run with dry_run: true.`
				);
			}
			const selection = await selectChainCandidates(getOsmStore(), getDb(), {
				area: {
					bbox: input.bbox ? toBounds(input.bbox) : undefined,
					latitude: input.latitude,
					longitude: input.longitude,
					radius_km: input.radius_km
				},
				nameMatch: input.name_match,
				brandWikidata: input.brand_wikidata,
				country: input.country
			});
			// The cap applies to IMPORTABLE candidates only: slicing the raw matched
			// list would let a long run of address-unresolvable POIs occupy the window
			// forever, leaving valid branches behind them unreachable on every re-run.
			const { importable, unresolvable } = partitionImportable(selection.matched);
			const max = input.max ?? 500;
			const toImport = importable.slice(0, max);
			const remaining = importable.length - toImport.length;

			if (input.dry_run) {
				return {
					dry_run: true,
					would_import: toImport.length,
					remaining_beyond_max: remaining,
					skipped_unresolvable: unresolvable,
					excluded_existing: selection.excluded_existing,
					...(input.country ? { excluded_foreign: selection.excluded_foreign } : {}),
					...(selection.excluded_foreign_sample.length
						? { excluded_foreign_sample: selection.excluded_foreign_sample }
						: {}),
					...(input.brand_wikidata ? { matched_by_brand: selection.matched_by_brand } : {}),
					scan_truncated: selection.scan_truncated,
					name_buckets: selection.name_buckets,
					sample: toImport.slice(0, 10).map((poi) => ({
						osm_id: poi.osm_id,
						name: poi.name,
						address: poi.address,
						admin_city: poi.admin_city,
						admin_region: poi.admin_region
					}))
				};
			}

			// Import through the same core as create_locations, in bounded chunks so
			// one D1 batch never carries hundreds of statements. skip_invalid semantics:
			// a residual invalid row (normalization edge case) is reported, not fatal.
			const CHUNK = 50;
			const locationIds: string[] = [];
			const skippedDuplicates: { name: string; existing_id: string | null }[] = [];
			const skippedInvalid: SkippedInvalid[] = [];
			const warnings: string[] = [];
			let created = 0;
			for (let i = 0; i < toImport.length; i += CHUNK) {
				const items = toImport.slice(i, i + CHUNK).map(
					(poi): CreateLocationItem => ({
						name: input.location_name,
						osm_id: poi.osm_id,
						category: input.category,
						phone: poi.phone,
						website: poi.website ?? input.website ?? null,
						brand_id: input.brand_id,
						menu_id: input.menu_id
					})
				);
				let res: CreateLocationsResult;
				try {
					res = await createLocationsBatch(items, { skipInvalid: true });
				} catch (err) {
					// Chunks 1..N-1 are committed; surface their results instead of
					// discarding them with the error (see ToolPartialFailure). Chunk N
					// is a single D1 batch (atomic), so its branches count as
					// unprocessed alongside the tail.
					const cause = err instanceof Error ? err.message : String(err);
					throw new ToolPartialFailure(
						`import_chain failed after importing ${created} of ${toImport.length} branches ` +
							`(chunk starting at index ${i}): ${cause}. The ${created} imported branches are ` +
							`committed — re-run the same call to import the rest (committed branches are ` +
							`excluded as existing on re-runs).`,
						{
							imported: created,
							...(input.include_location_ids ? { location_ids: locationIds } : {}),
							...(skippedDuplicates.length
								? { skipped_duplicate_locations: skippedDuplicates }
								: {}),
							...(skippedInvalid.length ? { skipped_invalid: skippedInvalid } : {}),
							...(warnings.length ? { warnings } : {}),
							remaining_beyond_max: remaining + (toImport.length - i)
						}
					);
				}
				created += res.created;
				locationIds.push(...res.location_ids);
				skippedDuplicates.push(...(res.skipped_duplicate_locations ?? []));
				skippedInvalid.push(...(res.skipped_invalid ?? []));
				warnings.push(...(res.warnings ?? []));
			}
			return {
				imported: created,
				...(input.include_location_ids ? { location_ids: locationIds } : {}),
				excluded_existing: selection.excluded_existing,
				...(input.country ? { excluded_foreign: selection.excluded_foreign } : {}),
				...(selection.excluded_foreign_sample.length
					? { excluded_foreign_sample: selection.excluded_foreign_sample }
					: {}),
				...(input.brand_wikidata ? { matched_by_brand: selection.matched_by_brand } : {}),
				skipped_unresolvable: unresolvable,
				...(skippedDuplicates.length ? { skipped_duplicate_locations: skippedDuplicates } : {}),
				...(skippedInvalid.length ? { skipped_invalid: skippedInvalid } : {}),
				...(warnings.length ? { warnings } : {}),
				name_buckets: selection.name_buckets,
				remaining_beyond_max: remaining,
				scan_truncated: selection.scan_truncated
			};
		}
	}),
	defineTool({
		name: 'audit_locations',
		annotations: READ_ONLY,
		description:
			'Audit existing locations and surface a work-list. `check` selects the audit: "coordinate_drift" ' +
			"(stored coordinates that do NOT coincide with the location's OSM POI — fix with " +
			'update_locations), "missing_address" (empty or streetless addresses, with the OSM address to ' +
			'backfill where available), or "duplicate_locations" (same-name/same-brand pairs within a small ' +
			"radius — probably one venue stored twice; verify against the venue's own locator, then EITHER " +
			'delete_location the extra row OR record a confirmed two-real-venues pair with ' +
			'mark_not_duplicate so it stops being re-flagged — such pairs are counted in ' +
			'`suppressed_reviewed`, never re-listed). The first ' +
			'two compare against the LOCAL OSM staging store; duplicate_locations reads only the live D1. ' +
			'Results are worst-first / actionable-first; `limit` caps how many are returned and `additional` ' +
			"is how many more exist beyond it. See the `check` field for each mode's entry shape and which " +
			'options apply.',
		schema: auditLocationsArgs,
		handler: async (input) => {
			if (input.check === 'coordinate_drift') {
				return findCoordinateDrift(getOsmStore(), getDb(), {
					limit: input.limit,
					tolerance_m: input.tolerance_m,
					search_radius_m: input.search_radius_m,
					include_unmatched: input.include_unmatched
				});
			}
			if (input.check === 'duplicate_locations') {
				// Reads only the live D1 — no staging store needed.
				return findDuplicateLocations(getDb(), {
					radius_m: input.radius_m,
					limit: input.limit,
					brand_id: input.brand_id
				});
			}
			return findMissingAddress(getOsmStore(), getDb(), {
				limit: input.limit,
				search_radius_m: input.search_radius_m,
				include_incomplete: input.include_incomplete,
				include_unfixable: input.include_unfixable
			});
		}
	}),
	defineTool({
		name: 'mark_not_duplicate',
		annotations: CREATE,
		description:
			'Record the verdict that two locations flagged by audit_locations (check: "duplicate_locations") ' +
			'are in fact two REAL venues — not one venue double-mapped — so the pair is suppressed from every ' +
			'future duplicate audit (counted in its `suppressed_reviewed`) and the verification work is never ' +
			"re-paid. Use ONLY after verifying against the chain's/venue's own store locator or equally strong " +
			'evidence, and put that evidence in `reason`. The verdict is per-pair and survives until either ' +
			'location is deleted (it cascades away with the row). Idempotent: re-marking replaces the ' +
			'reason/date. Pass `revoke: true` to withdraw a verdict so the pair audits normally again. For the ' +
			'opposite verdict — one venue stored twice — do NOT use this; delete_location the redundant row.',
		schema: markNotDuplicateArgs,
		handler: async (input) => {
			if (input.revoke) {
				const revoked = await unmarkLocationsDistinct(
					getDb(),
					input.location_id_a,
					input.location_id_b
				);
				return { revoked };
			}
			const reason = input.reason?.trim();
			if (!reason) throw new Error('A `reason` (the verification evidence) is required.');
			const [locA, locB] = await Promise.all([
				getLocationById(getDb(), input.location_id_a),
				getLocationById(getDb(), input.location_id_b)
			]);
			if (!locA) throw new Error(`No location with id "${input.location_id_a}".`);
			if (!locB) throw new Error(`No location with id "${input.location_id_b}".`);
			const res = await markLocationsDistinct(
				getDb(),
				input.location_id_a,
				input.location_id_b,
				reason
			);
			return { marked: true, already_reviewed: res.already_reviewed };
		}
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
		// A partial failure stays an error (isError), but its body carries the
		// state the tool committed before failing — see ToolPartialFailure.
		if (err instanceof ToolPartialFailure) {
			return {
				content: [{ type: 'text' as const, text: partialFailureBody(err) }],
				isError: true
			};
		}
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
