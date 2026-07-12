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
	DEFAULT_CURRENCY,
	TAGS,
	type Bounds,
	type D1Like,
	type Item,
	type Location,
	type LocationWithTags
} from '../src/lib/server/db';
import {
	assertBrandMenuRefs,
	countMenuItems,
	getLocationsWithTags,
	getLocationById,
	getFoodByLocation,
	getItemById,
	updateItems,
	deleteItem,
	insertFoods,
	updateLocations,
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
	countLocations,
	findBrandIdsByName,
	findMenuIdsByName,
	itemNameCollisions,
	auditDismissals,
	dismissAuditFinding,
	undismissAuditFinding,
	orderedPair
} from '../src/lib/server/db-write';
import { createHttpD1 } from '../src/lib/server/d1-http';
import { CATEGORIES } from '../src/lib/category';
import {
	sourceInputSchema,
	SOURCE_KINDS_HINT,
	assertHasSource,
	normalizeSources
} from './mcp/source-input';
import { ToolPartialFailure, partialFailureBody } from './mcp/partial-failure';
import {
	createLocationsBatch,
	type CreateLocationInput,
	type CreateLocationsResult,
	type SkippedInvalid
} from './mcp/create-locations';
import { normalizeAddressPatch } from './mcp/address-patch';
import { assertItemMenuMoves, assertLocationRefPatches } from './mcp/ref-validation';
import { normalizeCountry } from '../src/lib/address';
import { normalizePhone } from '../src/lib/phone';
import { OPENING_HOURS_MAX_LEN } from '../src/lib/opening-hours';
import { hasNonHttpScheme } from '../src/lib/safe-url';
import { searchPoi } from './osm/search-poi';
import { selectChainCandidates, partitionImportable } from './osm/import-chain';
import { splitDismissKey } from './osm/audit-dismiss';
import { findCoordinateDrift } from './osm/find-coordinate-drift';
import { findIdentityDrift } from './osm/find-identity-drift';
import { findMissingAddress } from './osm/find-missing-address';
import { findDuplicateLocations } from './osm/find-duplicate-locations';
import { findIncompleteMenus } from './osm/find-incomplete-menus';
import { findNoDrinksMenus } from './osm/find-no-drinks-menu';
import { findHtmlEntities } from './osm/find-html-entities';
import { findMissingCourseTags } from './osm/find-missing-course-tags';
import { findUnlinkedChainBranches } from './osm/find-unlinked-chain-branches';
import {
	resolveListLimit,
	resolveListOffset,
	buildListLocationsPage
} from './mcp/list-locations-page';
import { itemNameView, menuItemsSummary } from './mcp/menu-views';
import { createChainBundle } from './mcp/create-chain';
import { deleteLocationsBatch } from './mcp/delete-locations';
import {
	listLocationsOutput,
	getLocationOutput,
	getItemOutput,
	getMenuOutput,
	getBrandOutput,
	auditLocationsOutput,
	createLocationsOutput,
	updateLocationsOutput,
	createItemsOutput,
	updateItemsOutput,
	createChainOutput,
	deleteLocationsOutput
} from './mcp/output-schemas';
import { OsmPoiStore } from './osm/poi-store';
import { OvertureLeadsStore } from './overture/leads-store';
import { searchOvertureLeads } from './overture/search-leads';
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

// getOsmStore, but absence-tolerant: for checks that only ENRICH their evidence
// from the staging store (duplicate_locations' phone fallback) — a missing
// store must not fail an audit documented as reading the live D1.
function tryGetOsmStore(): OsmPoiStore | undefined {
	try {
		return getOsmStore();
	} catch {
		return undefined;
	}
}

// The Overture leads table lives INSIDE the same SQLite file (built by
// `bun scripts/overture/build-leads.ts`); opened lazily/read-only the same way.
let _leadsStore: OvertureLeadsStore | undefined;
function getLeadsStore(): OvertureLeadsStore {
	return (_leadsStore ??= OvertureLeadsStore.openReadonly(
		process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite'
	));
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
const courseTagIdSet = new Set(courseTagIds);

// --- Course-tag completeness/exclusivity checks (shared by itemSchema and
// updateItemArgs) — every item needs at least one course tag; "food" (the
// explicit not-a-dessert-not-a-drink marker) can never combine with "dessert"
// or "drink"; a course tag is never valid inside `optional_tags` (it describes
// what the item factually IS, not something addable/omittable on request).

/** True when `tags` includes at least one course tag id. */
function hasCourseTag(tags: readonly string[]): boolean {
	return tags.some((t) => courseTagIdSet.has(t));
}

/** True when `tags` combines "food" with "dessert" and/or "drink" (never allowed). */
function hasFoodConflict(tags: readonly string[]): boolean {
	return tags.includes('food') && (tags.includes('dessert') || tags.includes('drink'));
}

/** True when any course tag id appears among `optionalTags` (never allowed). */
function hasOptionalCourseTag(optionalTags: readonly string[] | undefined): boolean {
	return (optionalTags ?? []).some((t) => courseTagIdSet.has(t));
}

const MISSING_COURSE_TAG_MSG =
	`every item must carry a course tag: ${courseTagIds.join(', ')} ("food" = explicitly neither ` +
	'dessert nor drink)';
const FOOD_COURSE_CONFLICT_MSG =
	'"food" (explicitly neither dessert nor drink) cannot combine with "dessert" or "drink" in `tags`';
const OPTIONAL_COURSE_TAG_MSG =
	'a course tag (food/dessert/drink) describes what the item factually is, not something addable/' +
	'omittable on request — remove it from `optional_tags`';

// The single source of truth for how tags are applied. Advertised to MCP clients
// via the server `instructions`, and reused verbatim in every tag-bearing tool
// description so the rule lives in exactly one place.
const TAG_POLICY =
	`Dietary tags (${dietaryTagIds.join(', ')}) are SOURCE-ASSERTED: apply one only when the source ` +
	`explicitly designates the item — via a dietary marker/label/section heading, or when the item's ` +
	`name as shown in the source contains the designation (e.g. "Vegan Burger", "Halal Chicken", ` +
	`"Vegetarian Thali"). Never infer a dietary tag from the ingredient list or general knowledge of ` +
	`the dish; when unsure, omit it. Allergen SYMBOL LEGENDS (◊/‡/*, "contains nuts", "contains ` +
	`gluten") assert PRESENCE only — the absence of a symbol is NOT a free-of designation, so never ` +
	`derive nut_free / gluten_free / dairy_free from an item merely lacking a symbol. (An explicit ` +
	`free-of designation ON the item — a "GF" marker, "nut-free" in its name or the source's own ` +
	`free-of label — remains valid support; only symbol-ABSENCE is banned as evidence.) ` +
	`Course tags (${courseTagIds.join(', ')}) are FACTUAL, not source-` +
	'asserted, and every item REQUIRES at least one: "food" marks it as explicitly neither a dessert ' +
	'nor a drink (so no course tag at all unambiguously means "never course-reviewed", not "food"), ' +
	'and it can never combine with "dessert" or "drink". "dessert" and "drink" MAY combine on one item ' +
	"when it's genuinely both (e.g. a milkshake). When an item's course is ambiguous, tie-break on the " +
	'source menu\'s OWN section placement ("Desserts", "Drinks", …); if the source is unsectioned, tag ' +
	'by what the item is served as. Course tags never belong in `optional_tags` — they describe what ' +
	'the item factually is, not something addable/omittable on request.';

// A one-line pointer to {@link TAG_POLICY} for the many per-field tag descriptions.
// The full policy is advertised once in the server instructions and the item-tool
// descriptions; repeating its ~600 chars on every tag field only bloats the
// advertised JSON Schema, so the fields just restate the load-bearing rule.
const TAG_POLICY_SHORT =
	'Dietary tags are SOURCE-ASSERTED — apply only when the source explicitly designates the item ' +
	'(name or marker), never inferred from ingredients; allergen symbol legends mark PRESENCE only, ' +
	"so a symbol's absence never supports a free-of tag. Course tags are factual and REQUIRED — every " +
	`item needs at least one of (${courseTagIds.join(', ')}); "food" = explicitly neither dessert nor ` +
	'drink and never combines with them; dessert+drink may combine when genuinely both; never put a ' +
	'course tag in `optional_tags`. See the server tag policy.';

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
	'or left out (e.g. an item that can be made vegan). Every item REQUIRES at least one course tag ' +
	`(${courseTagIds.join(', ')}) — "food" marks it as explicitly neither dessert nor drink; dessert+` +
	'drink may combine when genuinely both (a milkshake), but "food" never combines with either. ' +
	'Items do NOT store ingredients.';

// --- Field policies -------------------------------------------------------
// The correctness-critical rules that used to be repeated verbatim on every
// create/update field. Each full rule is stated ONCE here and advertised via the
// server instructions; the per-field descriptions carry only a terse load-bearing
// pointer (the *_SHORT / *_DESC constants) that references the policy by name.

// The naming rule (used by create_locations.name, update_locations.name and
// import_chain.location_name — was ~600 chars repeated three times).
const NAME_POLICY =
	"Naming — a location's `name` is the venue's own business/brand name as the source displays it " +
	'(e.g. "A&W", "Cactus Club Cafe") and NOTHING else. NEVER bake location data into it to tell ' +
	'branches apart: no street, intersection, city, neighbourhood, mall/plaza or landmark, and no ' +
	'parenthetical/suffix locator like "(Scott Road)", "- 72 Ave" or " Surrey" — branches at ' +
	'different addresses are EXPECTED to share an identical name (the map tells them apart by ' +
	'address/coordinates). No editorial annotation either: no former name "(formerly Bandidas ' +
	'Taqueria)", status note "(closed)", or tacked-on descriptor "(Tea & Coffee)". When adding from ' +
	"OSM, use the POI's `name` tag verbatim, dropping any such locator/annotation. Keep a word that " +
	'only LOOKS like an addition when the source shows it AS the name (e.g. "Published on Main", ' +
	'"MeeT on Main", "Almond Dosa - Pure Vegetarian"): the test is whether the venue calls itself ' +
	'that, not whether it locates or describes a branch.';

// The OSM-import / coordinate-exact rule (used by create_locations.osm_id).
const OSM_IMPORT_POLICY =
	'OSM import (`osm_id`) — PREFER passing the `osm_id` of a search_poi candidate: the server takes ' +
	"that POI's latitude/longitude VERBATIM (the coordinate-exact match the map's de-duplication " +
	'relies on — never copy or geocode coordinates) and fills the address from its addr:* tags, ' +
	'auto-citing osm_url. OMIT latitude/longitude when using osm_id (passing them is rejected); you ' +
	"MAY still pass address parts to override or supply what the POI lacks (from the POI's admin " +
	'context, never geocoded). Use manual latitude/longitude + address only for a venue not in OSM.';

// The structured-address rule (used by the street/city/region/postcode/country
// fields on both create_locations and update_locations).
const ADDRESS_POLICY =
	'Structured address — `street`, `city`, `region` and `country` are REQUIRED; `postcode` is ' +
	"optional. Take every part from the venue's OSM/Overture data — never geocode or invent one. " +
	'region/postcode/country are normalized server-side (province/state → 2-letter code, e.g. ' +
	'"Ontario" → "ON"; postcode → canonical spacing; country → ISO-2, defaulting to CA), so a source ' +
	'spelling is accepted as given; a partial/invalid postcode (e.g. a bare FSA) is dropped rather ' +
	'than stored.';

// The refresh-notes rule (used by create_menu.refresh_notes and update_menu.refresh_notes).
const REFRESH_NOTES_POLICY =
	"refresh_notes — banks HOW to refresh a menu's data for the next verification pass: the " +
	'machine-readable feed endpoint (ordering API, nutrition PDF, CMS query) plus fetch caveats (e.g. ' +
	'"menu page is client-rendered; use the ordering API behind it"). RECORD it whenever menu ' +
	'research discovers a non-obvious source; CHECK it (get_menu) before re-researching from scratch. ' +
	"It MUST include the venue's full menu-PAGE INVENTORY: before extracting a single item, " +
	"enumerate the site's nav for EVERY menu-shaped link (food, drinks, cocktails, dessert, happy " +
	'hour, brunch/lunch/dinner, kids) and list every URL found — including pages not yet ingested, ' +
	'flagged as such. A lone "Menu" link is rarely the whole menu; a recorded inventory is what ' +
	'stops the next refresh from re-scoping to whichever page turned up first and shipping a menu ' +
	'with no drinks or desserts.';

// The one-line load-bearing pointer stamped on every name field (see NAME_POLICY).
const NAME_DESC_SHORT =
	"The venue's own name ONLY — no location/branch (street, neighbourhood, mall, landmark) or " +
	'editorial annotation (former name, status note) baked in; branches share a name and are told ' +
	'apart by address. See the naming policy in the server instructions.';

const SERVER_INSTRUCTIONS =
	'CRUD tools over the food-map database (locations, chains/brands, and their menu items). Each ' +
	'Each MENU may carry source URLs documenting where its food data came from (the menu / ordering ' +
	'link, official nutrition or dietary pages) — provenance is MENU-LEVEL, so cite it on create_menu / ' +
	'update_menu (or via create_locations for an independent venue). Every menu should have at least one.\n\n' +
	'To find venues still missing from the map, use search_poi: it reads a local OpenStreetMap ' +
	'food-POI staging store (built offline, not the live D1), already de-duplicated against existing ' +
	'locations, and returns candidates each carrying an `osm_id` (pass it to create_locations to ' +
	'import OSM coordinates + address verbatim) — then add each with create_locations. To import a ' +
	"CHAIN's branches, do NOT loop search_poi/create_locations by hand: create the brand, its shared " +
	'menu and the menu items, then call import_chain once (dry_run first to vet the name allowlist; ' +
	"pass `brand_wikidata` to catch name variants via OSM's brand tag, and `country` to keep " +
	'neighbouring-country border POIs out) — it scans the whole area, filters by name, and imports ' +
	'every branch with OSM-verbatim coordinates/addresses (and per-branch opening hours where tagged) in one call. After bulk imports, ' +
	'audit_locations ' +
	'(check: "duplicate_locations") finds same-name pairs a few metres apart — OSM sometimes maps one ' +
	`venue twice; verify against the venue's own locator, then delete_locations the extra row, or ` +
	'dismiss a verified two-real-venues pair (dismiss_audit_finding with its dismiss_key) so it is ' +
	'never re-flagged.\n\n' +
	`${MODEL_OVERVIEW}\n\nTag policy: ${TAG_POLICY}\n\n` +
	'Field policies — the full rules the terse per-field descriptions point to:\n\n' +
	`${NAME_POLICY}\n\n${OSM_IMPORT_POLICY}\n\n${ADDRESS_POLICY}\n\n${REFRESH_NOTES_POLICY}`;

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
// Hours: length-bounded here; the write layer normalizes (dashes/whitespace)
// and derives the machine-readable weekly table (src/lib/opening-hours.ts).
const openingHoursSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(OPENING_HOURS_MAX_LEN)
);

// Terse per-field pointers reused on create_locations and update_locations — the
// full rules live in SERVER_INSTRUCTIONS (NAME_POLICY / OSM_IMPORT_POLICY /
// ADDRESS_POLICY above). NAME_DESC_SHORT is defined with the policies.
const STREET_DESC = 'House number + street (+ unit), e.g. "1909 W 4th Ave".';
const CITY_DESC = 'Municipality, e.g. "Vancouver".';
const REGION_DESC =
	'Province/state, e.g. "BC" or "British Columbia" (stored as the 2-letter code).';
const POSTCODE_DESC = 'Postal/ZIP code (optional); omit when the source has none.';
const COUNTRY_DESC = 'Country name or ISO-2 code (stored as ISO-2; defaults to CA).';
const PHONE_DESC =
	"The venue's phone (prefer its OSM contact:phone tag). Stored canonical (E.164, " +
	'e.g. "+16045551234") regardless of the source spelling; the display form is derived on read.';
const OPENING_HOURS_DESC =
	"The venue's weekly hours in OSM `opening_hours` syntax, e.g. " +
	'"Mo-Fr 08:00-18:00; Sa 09:00-17:00" ("PH off" tolerated; days omitted = closed). On an ' +
	'`osm_id` import this is FILLED FROM THE POI automatically when omitted — pass a value only to ' +
	"override with fresher hours from the venue's own site, or null to import without hours. The " +
	'server derives a machine-readable weekly table from it (`opening_hours_json`); a string beyond ' +
	'the OSM subset is stored raw-only (displayed verbatim, not machine-readable) with a warning.';
const OSM_ID_DESC =
	'PREFERRED way to add a venue: the `osm_id` of a search_poi candidate — the server then takes ' +
	"this venue's coordinates VERBATIM from that OSM POI (never geocoded/copied) and fills its " +
	"address from the POI's addr:* tags, auto-citing osm_url. OMIT latitude/longitude when using " +
	'osm_id (passing them is rejected). See the OSM-import policy in the server instructions.';

// A single citation: a URL the data came from, plus an optional human label.
// Sources are MENU-LEVEL (the app only records where a menu's food data came from
// — the menu link, official nutrition/dietary pages), so these ride on the menu
// tools (create_menu / update_menu / create_chain) and on create_locations' inline
// private menu. Each entry is a bare URL string or a { url, label } object (see
// source-input.ts).
// Source-QUALITY rule, appended to every sources input description. Sources are
// menu-level PROVENANCE a human reads to trust the data — so cite a few canonical,
// browsable pages, never one link per item and never raw API endpoints (those read
// as noise and build no trust). When the data came from a JSON/ordering API behind a
// client-rendered page, cite the PUBLIC page a user can open and bank the API
// endpoint in `refresh_notes` instead — the API is how you RE-FETCH, not how a reader
// VERIFIES.
const SOURCE_QUALITY_HINT =
	'Keep sources FEW and user-friendly (usually 1–3 canonical, browsable pages): the official ' +
	'menu/nutrition/allergen page, plus at most one aggregator (Uber Eats/DoorDash) or a nutrition PDF ' +
	'when it corroborates something the official page lacks. Do NOT cite one URL per item, and do NOT ' +
	'cite raw API/ordering endpoints (…/api/…, …/apiproxy/…, ?fuseaction=order): if the menu comes from ' +
	'such a feed behind a JS-rendered page, cite the public page a reader can open and record the feed ' +
	'endpoint in `refresh_notes` instead.';

// Menu sources on a CREATE that MUST cite at least one link (create_menu, and
// create_locations when it builds a private menu from inline items). Optional in
// the schema so `[]` is a clear validation error rather than a missing field; the
// tools enforce the non-empty requirement in their handlers.
const createSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			`Menu source URLs — where this menu's food data came from (${SOURCE_KINDS_HINT}). ` +
				'Each: a URL string, or { url, label }. Provide AT LEAST ONE link so the menu stays verifiable. ' +
				SOURCE_QUALITY_HINT
		)
	)
);

const updateSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			"REPLACES the menu's full source set (each: a URL string, or { url, label }). Pass [] to clear all " +
				'sources. To ADD a citation without resending the existing ones, use `add_sources` instead. ' +
				`Keep at least one menu link (${SOURCE_KINDS_HINT}). ` +
				SOURCE_QUALITY_HINT
		)
	)
);

const addSourcesSchema = v.optional(
	v.pipe(
		v.array(sourceInputSchema),
		v.description(
			'APPENDS these sources to the existing set (de-duplicated by url); existing sources are kept. ' +
				'Each: a URL string, or { url, label }. Use this to add a citation without re-sending the full ' +
				'set. Mutually exclusive with `sources` (which replaces) — passing both is rejected. ' +
				SOURCE_QUALITY_HINT
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
				'Short note with the closure evidence INCLUDING the source link, stored on the row (e.g. ' +
					'"Closed 2024 per Yelp permanently-closed + dead site https://…"). Provenance is menu-level, ' +
					'so a closed venue keeps its evidence here in the reason text. Strongly encouraged when ' +
					'closing; ignored when `reopen` is true.'
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
	)
});

// The item `description` is the source's own words, never authored. Reused by
// itemSchema (create) and updateItemArgs.
const ITEM_DESCRIPTION_DESC =
	"The item's description COPIED VERBATIM from the official menu source (the venue's own blurb " +
	'for this item). Never write, paraphrase or embellish one yourself — if the source shows no ' +
	'description, leave this null.';

// One menu item. Shared by create_items (the batch's location_id/menu_id is given
// once), and by the inline `menu_items` of an independent venue created via
// create_locations.
const itemSchema = v.pipe(
	v.object({
		item_name: v.pipe(v.string(), v.minLength(1), v.description('Name of the menu item.')),
		description: v.optional(v.nullable(v.pipe(v.string(), v.description(ITEM_DESCRIPTION_DESC)))),
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
		tags: v.pipe(
			v.array(tagIdSchema),
			v.description(
				'Tags to apply to this item. REQUIRED to include at least one course tag. ' +
					TAG_POLICY_SHORT
			)
		),
		optional_tags: optionalTagsSchema,
		id: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description('Optional explicit id; a UUID is generated when omitted.')
			)
		)
	}),
	v.check((item) => hasCourseTag(item.tags), MISSING_COURSE_TAG_MSG),
	v.check((item) => !hasFoodConflict(item.tags), FOOD_COURSE_CONFLICT_MSG),
	v.check((item) => !hasOptionalCourseTag(item.optional_tags), OPTIONAL_COURSE_TAG_MSG)
);

const createLocationArgs = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.description(NAME_DESC_SHORT)),
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
	phone: v.optional(v.nullable(v.pipe(v.string(), v.description(PHONE_DESC)))),
	website: v.optional(v.nullable(websiteSchema)),
	opening_hours: v.optional(
		v.nullable(v.pipe(openingHoursSchema, v.description(OPENING_HOURS_DESC)))
	),
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
	sources: v.optional(
		v.pipe(
			v.array(sourceInputSchema),
			v.description(
				`Menu source URLs for this venue's menu (${SOURCE_KINDS_HINT}). Each: a URL string, or ` +
					'{ url, label }. REQUIRED (at least one) when `menu_items` are given — they build the ' +
					"venue's private menu, and every menu must cite where its food data came from. Ignored for a " +
					'chain branch (its shared menu carries the sources) or a venue added with no menu. ' +
					SOURCE_QUALITY_HINT
			)
		)
	),
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
// optional; only the fields present are changed. Strict so an unknown field
// (e.g. the removed location-level `sources`, now menu-level on update_menu)
// fails loudly instead of being silently dropped and reported as updated.
// Exported for scripts/update-locations.test.ts.
export const updateLocationItemArgs = v.pipe(
	v.strictObject({
		id: v.pipe(v.string(), v.minLength(1), v.description('Id of the location to update.')),
		name: v.optional(
			v.pipe(v.string(), v.minLength(1), v.description(`Replace the name. ${NAME_DESC_SHORT}`))
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
		phone: v.optional(
			v.nullable(v.pipe(v.string(), v.description(`Replace the phone. ${PHONE_DESC}`)))
		),
		website: v.optional(v.nullable(websiteSchema)),
		opening_hours: v.optional(
			v.nullable(
				v.pipe(
					openingHoursSchema,
					v.description(
						`Replace the weekly hours (null clears them, and the derived table with them). ${OPENING_HOURS_DESC}`
					)
				)
			)
		),
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
		)
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

const deleteLocationsArgs = v.object({
	ids: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1))),
		v.minLength(1),
		v.maxLength(100),
		v.description(
			'Ids of the locations to HARD-delete (1-100), mirroring the batched update_locations. Each ' +
				"delete cascades that venue's sources/overrides/likes and orphans its private menu — PREFER " +
				'close_location for a real venue that has permanently closed (it preserves likes); reserve ' +
				'this for mistaken/duplicate rows. Ids matching no row come back in `not_found_ids`.'
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
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.description(
				'Maximum rows to return in this page (default 50, max 200; a larger value is clamped). ' +
					'Ignored when `count_only` is true.'
			)
		)
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

// get_location takes the SAME `view` selector as get_menu, but DEFAULTS to "full"
// rather than "names": a single venue's own private menu is typically small, so
// returning it in full by default is cheap and useful — unlike get_menu, whose
// target is often a shared chain menu of hundreds of items. Only the default
// differs; the three view shapes are identical (see scripts/mcp/menu-views.ts).
const getLocationArgs = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.description('The record id (UUID).')),
	view: v.optional(
		v.pipe(
			v.picklist(['full', 'names', 'summary']),
			v.description(
				'Payload size for the inline `menu`. DEFAULT is "full" — every owned item with its ' +
					"description, sources and optional-tag detail (a single venue's menu is usually small). " +
					'"names" returns items as just { id, item_name, price, tags }; "summary" returns no item ' +
					'list, just counts and a per-tag histogram. (Contrast get_menu, which defaults to "names".)'
			)
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
	return {
		minLat: b.min_lat,
		maxLat: b.max_lat,
		minLng: b.min_lon,
		maxLng: b.max_lon
	};
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

const searchOvertureLeadsArgs = v.pipe(
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
				v.description(
					'Bounding box to search. Area is optional: give this, OR a centre ' +
						'(latitude+longitude+radius_km), OR neither to query the whole pool.'
				)
			)
		),
		city: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description("Case-insensitive substring match on the lead's Overture locality (city).")
			)
		),
		province: v.optional(
			v.pipe(
				v.string(),
				v.trim(),
				v.transform((s) => s.toUpperCase()),
				v.regex(/^[A-Z]{2}$/, 'province must be a 2-letter code, e.g. "BC".'),
				v.description('2-letter Canadian province code the lead resolved to, e.g. "BC".')
			)
		),
		name: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description('Case-insensitive substring match on the lead name OR brand name.')
			)
		),
		min_confidence: v.optional(
			v.pipe(
				v.number(),
				v.minValue(0),
				v.maxValue(1),
				v.description(
					'Overture confidence floor for every row. OMIT it to get the defaults: 0.85 for rows ' +
						'with a brand signal, 0.9 for independents (the junk guard — see the tool description).'
				)
			)
		),
		brands_only: v.optional(
			v.pipe(
				v.boolean(),
				v.description('Only leads carrying a brand signal (brand_wikidata or brand_name).')
			)
		),
		exclude_existing: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Omit leads already covered by a live venue — a name-related location within 500 m ' +
						'(default true).'
				)
			)
		),
		limit: v.optional(
			v.pipe(
				v.number(),
				v.integer(),
				v.minValue(1),
				v.maxValue(200),
				v.description('Maximum leads per page (default 50, max 200).')
			)
		),
		offset: v.optional(
			v.pipe(
				v.number(),
				v.integer(),
				v.minValue(0),
				v.description('Skip this many leads (paging).')
			)
		)
	}),
	v.check((input) => {
		const hasBbox = input.bbox !== undefined;
		const centreCount = [input.latitude, input.longitude, input.radius_km].filter(
			(value) => value !== undefined
		).length;
		// Area is OPTIONAL here (no area = whole pool), but a given area must still
		// be exactly one complete mode — mirrors searchPoiArgs.
		return hasBbox ? centreCount === 0 : centreCount === 0 || centreCount === 3;
	}, 'Provide `bbox`, OR all of `latitude`, `longitude` and `radius_km`, OR no area at all (not both, and centre coordinates must be complete).')
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
				'The canonical name stored on every imported branch, e.g. "Harvey\'s". ' + NAME_DESC_SHORT
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

// The audit checks, shared between audit_locations' selector and
// dismiss_audit_finding's scope (a dismissal is per-check).
const AUDIT_CHECKS_SCHEMA = v.picklist([
	'coordinate_drift',
	'identity_drift',
	'missing_address',
	'duplicate_locations',
	'empty_menu',
	'html_entities',
	'missing_course_tag',
	'no_drinks_menu',
	'unlinked_chain_branch'
]);

// One tool, two audits against the local OSM staging store, selected by `check`.
// `limit`/`search_radius_m` apply to both; the remaining options are mode-specific
// (flagged in their descriptions) and simply ignored by the audit they don't apply to.
const auditLocationsArgs = v.object({
	check: v.pipe(
		AUDIT_CHECKS_SCHEMA,
		v.description(
			'Which audit to run:\n' +
				'• "coordinate_drift" — locations whose stored coordinates do NOT coincide with their ' +
				'OpenStreetMap POI. Each `drifted` entry carries the matched POI (`osm_url`, `osm_latitude`, ' +
				'`osm_longitude`, `distance_m`, `matched_osm_name`) — pass `osm_latitude`/`osm_longitude` to ' +
				'update_locations to snap it back, citing `osm_url`. Locations with no name-matching POI nearby ' +
				'are reported as `no_osm_match` (omit via include_unmatched=false).\n' +
				'• "identity_drift" — locations whose staging POI AT their exact stored coordinates no longer ' +
				'carries their name. Coordinates are OSM-verbatim, so the POI at ~0 m IS the source node: ' +
				'"renamed" means OSM re-tagged that node to a new occupant (`current_osm_name`, `osm_url`) — the ' +
				'venue was likely replaced or moved; "vanished" means no POI sits there at all (node deleted, ' +
				'moved, or extract-dropped as closed-tagged; omit via include_vanished=false). Either may carry a ' +
				'`relocation_lead` (the nearest name-matching POI within `search_radius_m` — a hint the venue ' +
				"moved, not closed). Verify against the venue's own site, then close_location the departed row, " +
				'update_locations onto the relocation lead, and/or import the new occupant. Complements ' +
				'coordinate_drift (which anchors on the NAME; this anchors on the POSITION) — and it is only as ' +
				'fresh as the staging store, so rebuild that (bun run osm:extract) before trusting a sweep.\n' +
				'• "missing_address" — locations whose stored address is empty (`reason: "missing"`) or, unless ' +
				'include_incomplete=false, a streetless fragment like a bare house number/postcode (`reason: ' +
				'"incomplete"`). Each entry is classified `osm_fix_available` (a nearby name-matching POI HAS an ' +
				'address — pass its `osm_address_parts` to update_locations, or split the `osm_address` preview ' +
				'when parts are absent, and cite `osm_url`), `osm_has_no_address`, or `no_osm_match`. Set ' +
				'include_unfixable=false for just the OSM-fixable work list.\n' +
				'• "duplicate_locations" — pairs of live locations within `radius_m` (default 150) whose names ' +
				'match or that share a brand: probably ONE venue stored twice (OSM sometimes carries two stale ' +
				"nodes for one place — coordinate-exact dedup cannot catch that). Each pair carries both halves' " +
				'phone/website/postcode, a `same_phone` flag (a shared phone ≈ the same store), a ' +
				'`same_phone_staging` flag (phones matched only after a phone-less half borrowed its staging ' +
				"POI's — often Overture-enriched — phone via its osm_id: weaker, corroborating evidence, never " +
				'a confidence upgrade; `same_phone_staging_same_donor: true` additionally means both staging ' +
				'phones trace to ONE Overture place — a single upstream datum echoed twice, not two records ' +
				'agreeing) and a `confidence` ' +
				'classification: "high" (name match within ~30 m, or shared phone) vs "review". Nearest pairs ' +
				"first; scope a post-import sweep with `brand_id`. Verify each against the venue's own store " +
				'locator before delete_locations — two real branches CAN sit close together.\n' +
				'• "empty_menu" — OPEN locations whose EFFECTIVE menu has fewer than `min_items` items (default ' +
				'1, so only truly-empty menus; raise it to hunt suspiciously thin ones). Effective count = the ' +
				"items on the location's menu (its private menu, or a chain branch's shared menu) MINUS the ones " +
				'this branch overrode to unavailable; a location with no menu counts as 0. Surfaces venues that ' +
				'violate the EXHAUSTIVE-menu policy — a create_locations never followed by create_items, an ' +
				'import_chain onto an empty menu. Each `locations` entry is { id, name, address, item_count, ' +
				'brand_id, menu_id }, worst-first (0-item menus lead). Reads only the live D1.\n' +
				'• "html_entities" — display text still carrying HTML-ENCODED character references ' +
				'("Bacon &amp; Egg", "&#39;") instead of the decoded character. Every write path decodes on ' +
				'ingestion, so this should always be EMPTY — a hit means encoded text predates the decoder or ' +
				'slipped in some other way. Scans item names/descriptions plus location/menu/brand names; ' +
				'returns { items, locations, menus, brands } where every entry carries the stored `value`/`name` ' +
				'and the `decoded` text to write back (via update_items / update_locations / update_menu / ' +
				'update_brand), and each flagged item lists the locations serving its menu. Reads only the live D1.\n' +
				'• "missing_course_tag" — items with NO required (non-optional) course tag (food/dessert/' +
				'drink). Per the course-tag mandate, no course tag means the item was never course-reviewed ' +
				'(NOT "food" by default). This audit is PAGED — use `limit`/`offset` (this check only) to work ' +
				'through the backlog, `total` is the full flagged count. Each entry is { id, item_name, menu_id, ' +
				'menu_name, location_count, hint }: `location_count` is how many live locations serve that menu; ' +
				"`hint` ('drink' | 'dessert' | null) is a CHEAP KEYWORD HEURISTIC suggesting the likely tag — " +
				'verify against the source before applying it, never trust it blindly. Ordered hint-first (drink, ' +
				'then dessert, then no hint), then by menu. Fix by re-tagging with update_items, passing the full ' +
				'corrected `tags` set (course tag plus any dietary tags the source supports). Dismissals for ' +
				'this check should be ~NEVER used: the course-tag mandate makes every item taggable (tie-break ' +
				'on the source menu section, or on what the item is served as) — re-tag instead. Reads only ' +
				'the live D1.\n' +
				'• "no_drinks_menu" — OPEN restaurant-category venues whose effective menu has items (at ' +
				'least `min_items`, default 1) but ZERO drink-tagged ones: the classic tell that menu ' +
				'research missed a separate drinks/cocktails/happy-hour PAGE (menus are routinely split ' +
				'across pages, and a lone "Menu" link is rarely the whole menu). Biggest menus first — the ' +
				'more items a drink-less menu carries, the more certain a page was missed. Each entry is ' +
				'{ id, name, address, item_count, brand_id, menu_id }. Fix by re-reading the venue site NAV ' +
				'for every menu-shaped link (drinks/happy hour/brunch/kids), ingesting the missed pages, and ' +
				"listing the full page inventory in the menu's refresh_notes; dismiss only a venue VERIFIED " +
				'to genuinely list no drinks (the dismissal pins the item count — a changed menu re-flags). ' +
				'Empty menus are left to empty_menu. Reads only the live D1.\n' +
				'• "unlinked_chain_branch" — INDEPENDENT venues (brand_id IS NULL) whose name matches an existing ' +
				'chain: a branch that was never linked to its chain, so it serves a stale private menu instead of ' +
				'the shared chain menu every real branch shows (issue #242). import_chain excludes a pre-existing ' +
				"venue at a chain's spot as an already-on-the-map dedup but leaves it un-adopted, and " +
				'duplicate_locations cannot catch it (no second row was created to pair against). Each `unlinked` ' +
				'entry is { id, name, address, menu_id, item_count, brand: { id, name } }; the name match reuses ' +
				"import_chain's own normalized matching. Verify against the chain's locator, then adopt with " +
				'update_locations (set brand_id + the shared menu_id) and delete_menu its private menu, or ' +
				'delete_locations a bad row. Only OPEN venues are flagged. Reads only the live D1.'
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
	min_items: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.description(
				'[empty_menu / no_drinks_menu] For empty_menu: flag locations whose effective menu has ' +
					'FEWER than this many items (default 1 ⇒ only empty menus; raise it to catch suspiciously ' +
					'thin menus). For no_drinks_menu: only consider venues with AT LEAST this many effective ' +
					'items (default 1; raise it to focus on the big menus where a missed drinks page is near-certain).'
			)
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
				'[coordinate_drift / identity_drift] How close (metres) a POI must sit to count as AT the ' +
					"location — coordinate_drift's aligned threshold, identity_drift's same-spot threshold " +
					'(default 1: coordinates are OSM-verbatim, so the source POI is coordinate-exact).'
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
	include_vanished: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'[identity_drift only] Also report locations whose staging POI is gone entirely from their ' +
					'coordinates, not just renamed ones (default true).'
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
	),
	offset: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(0),
			v.description(
				'[missing_course_tag only] Skip this many flagged items (paging) — the backlog is large, so ' +
					'drain it in pages via `limit`/`offset` rather than in one call.'
			)
		)
	),
	include_dismissed: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Also return findings a dismissal (dismiss_audit_finding) suppresses, each annotated with ' +
					'`dismissed: { reason, dismissed_at }` — for reviewing past verdicts. Default false: ' +
					'dismissed findings are dropped and only counted in `suppressed_dismissed`.'
			)
		)
	)
});

const dismissAuditFindingArgs = v.pipe(
	v.object({
		check: v.pipe(
			AUDIT_CHECKS_SCHEMA,
			v.description('The audit check that produced the finding being dismissed.')
		),
		dismiss_key: v.pipe(
			v.string(),
			v.minLength(2),
			v.description(
				"The finding's `dismiss_key`, copied VERBATIM from the audit_locations entry " +
					'("<subject>#<evidence fingerprint>"). Never compose one by hand — the fingerprint pins ' +
					'the evidence that was verified, and a hand-built key that never matches suppresses nothing.'
			)
		),
		reason: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					'The verification evidence, stored on the dismissal — e.g. "both branches listed separately ' +
						'on restaurants.subway.com with distinct phone numbers". Required unless `revoke` is true.'
				)
			)
		),
		revoke: v.optional(
			v.pipe(
				v.boolean(),
				v.description(
					'Set true to WITHDRAW the dismissal — the finding shows up in audits again. Matches on the ' +
						'subject (the part before "#"), so the current fingerprint need not match.'
				)
			)
		)
	}),
	v.check(
		(input) => input.dismiss_key.indexOf('#') > 0,
		'dismiss_key must be "<subject>#<fingerprint>" as returned by audit_locations.'
	),
	v.check(
		(input) => Boolean(input.revoke) || Boolean(input.reason?.trim()),
		'A `reason` (the verification evidence) is required when recording a dismissal.'
	)
);

// --- Chains: brands, menus, menu items, per-location overrides ---

// Written at research time, read before ANY re-verification — re-discovering how
// to fetch a chain's menu (finding the API behind a client-rendered page) is the
// dominant cost of a refresh, and this is where that knowledge is banked.
const REFRESH_NOTES_DESC =
	"HOW to re-fetch this menu's source, banked for the next verification pass (the machine-readable " +
	'feed endpoint + fetch caveats) and read back (get_menu) before re-researching from scratch. ' +
	'MUST list the full menu-page inventory — every menu-shaped nav link (food/drinks/happy hour/' +
	'brunch/kids), including pages not yet ingested. See the refresh-notes policy in the server ' +
	'instructions.';

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
	// last_verified is not accepted: any update re-stamps it to today automatically
	// (unless stamp_verified: false).
	refresh_notes: v.optional(
		v.nullable(v.pipe(v.string(), v.description(REFRESH_NOTES_DESC + ' Pass null to clear.')))
	),
	sources: updateSourcesSchema,
	add_sources: addSourcesSchema,
	stamp_verified: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Default true: any update re-stamps last_verified to today. Pass false to bank ' +
					'refresh_notes/sources WITHOUT marking the menu verified — e.g. recording the fuller ' +
					"menu-page inventory an INCOMPLETE refresh discovered, when the menu's items were NOT " +
					're-checked against the source.'
			)
		)
	)
});

// create_chain bundles create_brand + create_menu + create_items into one call.
// The sub-schemas are REUSED verbatim (no duplicated validation): `createBrandArgs`
// for the brand, `createMenuArgs` minus its brand_id (the bundled brand supplies it)
// for the menu, and the shared `itemSchema` for the items.
const createChainArgs = v.object({
	brand: v.pipe(
		createBrandArgs,
		v.description(
			'The chain/brand to create — or reuse by passing an existing `id` (a no-op returning ' +
				'already_existed).'
		)
	),
	menu: v.pipe(
		v.omit(createMenuArgs, ['brand_id']),
		v.description(
			'The shared regional menu to create under the brand (its brand_id is the bundled brand). ' +
				'Reuse by passing an existing `id` (a no-op returning already_existed).'
		)
	),
	items: v.pipe(
		v.array(itemSchema),
		v.maxLength(500),
		v.description(
			"The menu's shared items (same shape as create_items). May be [] to scaffold just the brand + " +
				'menu now and add the items later with create_items (using the returned menu_id).'
		)
	)
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
				'Payload size. DEFAULT is "names" — id/item_name/price/tags per item only. Pass view: "full" ' +
					'to get item descriptions, sources and optional-tag detail — REQUIRED when verifying dietary ' +
					'tags or reading descriptions; a shared chain menu can be hundreds of items, so full is ' +
					'opt-in. "summary" returns no item list, just counts and a per-tag histogram.'
			)
		)
	)
});

// One item patch within an update_items batch. Every field but `id` is optional;
// only the fields present are changed.
const updateItemArgs = v.pipe(
	v.object({
		id: v.pipe(v.string(), v.minLength(1), v.description('Id of the item to update.')),
		menu_id: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.description(
					'Move the item to a different menu of the SAME brand (rare). A move targeting a ' +
						"nonexistent menu, another venue's private menu, or another brand's shared menu is rejected."
				)
			)
		),
		item_name: v.optional(v.pipe(v.string(), v.minLength(1))),
		description: v.optional(
			v.nullable(v.pipe(v.string(), v.description(ITEM_DESCRIPTION_DESC + ' Pass null to clear.')))
		),
		price: v.optional(v.nullable(priceSchema)),
		tags: v.optional(
			v.pipe(
				v.array(tagIdSchema),
				v.description(
					'Replaces the full dietary/course tag set for this item. Must include at least one course ' +
						'tag when provided (an item always needs one) — omit `tags` entirely to leave it unchanged. ' +
						'PREFER add_tags/remove_tags for incremental edits: restating the set from partial ' +
						'knowledge silently drops dietary tags it forgets. ' +
						TAG_POLICY_SHORT
				)
			)
		),
		optional_tags: optionalTagsSchema,
		add_tags: v.optional(
			v.pipe(
				v.array(tagIdSchema),
				v.description(
					'MERGE op: link these as required tags WITHOUT restating the rest of the set (a tag ' +
						'currently optional moves to required). The safe way to add one tag — unlike `tags`, ' +
						'nothing already on the item is touched. Mutually exclusive with `tags`/`optional_tags`. ' +
						TAG_POLICY_SHORT
				)
			)
		),
		add_optional_tags: v.optional(
			v.pipe(
				v.array(tagIdSchema),
				v.description(
					'MERGE op: link these as OPTIONAL tags (satisfiable on request, e.g. "can be made vegan") ' +
						'without restating the set; a tag currently required moves to optional. Course tags are ' +
						'never optional. Mutually exclusive with `tags`/`optional_tags`.'
				)
			)
		),
		remove_tags: v.optional(
			v.pipe(
				v.array(tagIdSchema),
				v.description(
					'MERGE op: unlink these tags (from BOTH the required and optional set) without restating ' +
						'the rest. Removing the last course tag is rejected — add the corrected course tag via ' +
						'add_tags in the same patch. Mutually exclusive with `tags`/`optional_tags`.'
				)
			)
		)
	}),
	v.check((item) => item.tags === undefined || hasCourseTag(item.tags), MISSING_COURSE_TAG_MSG),
	v.check(
		(item) => item.tags === undefined || !hasFoodConflict(item.tags),
		FOOD_COURSE_CONFLICT_MSG
	),
	v.check((item) => !hasOptionalCourseTag(item.optional_tags), OPTIONAL_COURSE_TAG_MSG),
	v.check(
		(item) =>
			(item.tags === undefined && item.optional_tags === undefined) ||
			(item.add_tags === undefined &&
				item.add_optional_tags === undefined &&
				item.remove_tags === undefined),
		'pass EITHER the replace sets (`tags`/`optional_tags`) OR the merge ops (`add_tags`/' +
			'`add_optional_tags`/`remove_tags`) in one patch, not both'
	),
	v.check(
		(item) =>
			!(item.remove_tags ?? []).some(
				(tag) => item.add_tags?.includes(tag) || item.add_optional_tags?.includes(tag)
			),
		'a tag cannot appear in both remove_tags and an add op in the same patch'
	),
	v.check((item) => !hasFoodConflict(item.add_tags ?? []), FOOD_COURSE_CONFLICT_MSG),
	v.check((item) => !hasOptionalCourseTag(item.add_optional_tags), OPTIONAL_COURSE_TAG_MSG)
);

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
	/**
	 * Optional valibot schema advertised as the tool's MCP `outputSchema` (and the
	 * contract its `structuredContent` conforms to). Declared only for the high-value
	 * object-returning tools; kept PERMISSIVE (see scripts/mcp/output-schemas.ts) so a
	 * strict client never rejects a valid response. A tool that returns a bare array,
	 * null or a primitive omits it — structuredContent must be a JSON object.
	 */
	outputSchema?: AnySchema;
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
const CREATE = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false
} as const;
const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false
} as const;

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
		opening_hours: loc.opening_hours,
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
	const rows = await getLocationsWithTags(getDb(), {
		category,
		nameLike,
		brandId,
		limit,
		offset
	});
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
		outputSchema: listLocationsOutput,
		description:
			'List locations in the LIVE map database as a lightweight overview — id, name, category, ' +
			'coordinates, address, phone, website, opening_hours, brand_id/menu_id (set for chain branches), and the distinct ' +
			'tag ids offered across the effective menu (no per-item detail, no source URLs). Pass `query` to ' +
			'match by name (case-insensitive substring) — e.g. to check whether a venue is already on the map ' +
			'(de-dup before adding) or to find one to edit; this reads the live D1, distinct from search_poi ' +
			'which finds OSM venues NOT yet on the map. Narrow with `near`/`category`/`brand_id` (exact chain ' +
			'membership — better than a name substring for enumerating branches). Returns ' +
			'{ locations, returned, has_more, limit, offset }: a page of at most `limit` rows (default 50, ' +
			'max 200), with `has_more: true` when more match beyond this page — pass `offset` to fetch the ' +
			'next page. Pass `count_only: true` for just { count } of matching locations (cheap chain-size ' +
			'audits; `limit`/`offset` ignored). Use get_location for a single place with its full menu and sources.',
		schema: listLocationsArgs,
		handler: async ({ query, near, category, brand_id, count_only, limit, offset }) => {
			if (count_only) {
				// `near` counts refine to the exact circle via the same query path.
				if (near) {
					const rows = await queryLocations({
						near,
						category,
						nameLike: query,
						brandId: brand_id
					});
					return { count: rows.length };
				}
				return {
					count: await countLocations(getDb(), {
						category,
						nameLike: query,
						brandId: brand_id
					})
				};
			}
			// Cap + truncation signal, mirroring search_poi/audit_locations. Over-fetch one
			// row (limit + 1) so `has_more` is free — no second COUNT query. The +1 probe
			// works for both the SQL path and the in-memory `near` slice.
			const effLimit = resolveListLimit(limit);
			const effOffset = resolveListOffset(offset);
			const rows = await queryLocations({
				near,
				category,
				nameLike: query,
				brandId: brand_id,
				limit: effLimit + 1,
				offset: effOffset
			});
			return buildListLocationsPage(rows, effLimit, effOffset);
		}
	}),
	defineTool({
		name: 'get_location',
		annotations: READ_ONLY,
		outputSchema: getLocationOutput,
		description:
			"Get a single location with its `sources` (its menu's source URLs — provenance is menu-level) " +
			'and its inline `menu` (the items owned directly ' +
			'by this venue on its own private menu; each omits the menu-level `currency`/`menu_id`, ' +
			'surfaced once as the top-level `currency`). `view` controls the `menu` payload and DEFAULTS ' +
			'to "full" (every item in detail, since a single venue\'s menu is typically small); pass ' +
			'"names" for id/item_name/price/tags per item, or "summary" for counts + a tag histogram ' +
			'with no item list. If `menu_id` is a shared brand menu the location is a chain branch — call ' +
			"get_menu to see/edit those items; `overrides` lists this branch's per-item deviations from " +
			'them. Returns null if not found.',
		schema: getLocationArgs,
		handler: async ({ id, view }) => {
			const location = await getLocationById(getDb(), id);
			if (!location) return null;
			const [menu, overrides, menuRow] = await Promise.all([
				getFoodByLocation(getDb(), id),
				getLocationItemOverrides(getDb(), id),
				// Provenance is menu-level: surface the venue's menu sources as its `sources`.
				location.menu_id ? getMenuById(getDb(), location.menu_id) : Promise.resolve(null)
			]);
			// An independent venue's items all live on one private menu, so the menu-level
			// currency/menu_id are identical across them: surface currency once at the top
			// and drop the per-item copies (see itemWithinParent).
			const currency = menu[0]?.currency;
			// The derived weekly table (opening_hours_json) is an app/SQL concern;
			// agents read and write only the raw `opening_hours` string.
			const { opening_hours_json: _ohJson, ...locationOut } = location;
			const base = {
				...locationOut,
				sources: menuRow?.sources ?? [],
				...(currency ? { currency } : {})
			};
			if (view === 'summary') {
				// counts + tag histogram, no item list (mirrors get_menu's summary view).
				return { ...base, ...menuItemsSummary(menu), overrides };
			}
			const menuItems = view === 'names' ? menu.map(itemNameView) : menu.map(itemWithinParent);
			return { ...base, menu: menuItems, overrides };
		}
	}),
	defineTool({
		name: 'create_locations',
		annotations: CREATE,
		outputSchema: createLocationsOutput,
		description:
			'Create one or more locations in a single batch — the only way to add ' +
			"locations; pass a one-item `items` array for a single place. PREFERRED: set each item's " +
			'`osm_id` from a search_poi candidate (see the `osm_id` field doc) so coordinates + address — and ' +
			'`opening_hours`, unless you pass your own (or null to suppress) — come ' +
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
			'Large batches are written in bounded chunks (each location atomic with its inline menu); if a ' +
			'later chunk fails, the error reports the committed part as a partial failure — re-running the ' +
			'same call is safe (committed rows skip via id/coordinate dedup). ' +
			'Returns { created, location_ids, items_created, item_ids, skipped_existing_ids, ' +
			'skipped_duplicate_locations, skipped_invalid, warnings } — `warnings` flags dropped partial ' +
			'postcodes and same-name venues within ~150 m (possible OSM double-mapping worth verifying); ' +
			'fetch details with get_location if needed.',
		schema: createLocationsArgs,
		handler: ({ items, skip_invalid }) =>
			createLocationsBatch(getDb(), getOsmStore(), items, {
				skipInvalid: skip_invalid
			})
	}),
	defineTool({
		name: 'update_locations',
		annotations: DESTRUCTIVE,
		outputSchema: updateLocationsOutput,
		description:
			'Update one or more existing locations in a single atomic batch — pass a one-item `items` array to ' +
			'edit one place. Each patch carries an `id` plus only the fields to change; unknown fields are ' +
			'rejected. Provenance is MENU-level, so there is no `sources` field here — cite sources on the ' +
			"venue's menu via update_menu instead. Set `menu_id`/`brand_id` (together) to attach a " +
			'branch to a chain menu, or null to detach it. region/postcode/country are normalized for you. ' +
			'Ideal for mass backfills from audit_locations. Ids that do not exist ' +
			'are skipped and listed in `not_found_ids`. Returns { updated, updated_ids, not_found_ids }.',
		schema: updateLocationsArgs,
		handler: async ({ items }) => {
			// Stored rows serve two validations — a single-sided brand/menu patch
			// merges with the stored pair, and a region/postcode patch scopes to the
			// stored country — so fetch each id at most once and share the result.
			const storedRows = new Map<string, Promise<Location | null>>();
			const getStored = (id: string): Promise<Location | null> => {
				let row = storedRows.get(id);
				if (!row) {
					row = getLocationById(getDb(), id);
					storedRows.set(id, row);
				}
				return row;
			};
			// Validate brand/menu references BEFORE any write: a full pair as given,
			// a single-sided patch against the EFFECTIVE post-patch pair (see
			// assertLocationRefPatches) — { brand_id: null } alone on a chain branch
			// or a lone cross-brand brand_id must not slip past assertBrandMenuRefs.
			await assertLocationRefPatches(getDb(), items, getStored);
			const patches = await Promise.all(
				items.map(async ({ id, street, city, region, postcode, country, phone, ...patch }) => {
					// A patch that touches region/postcode/phone WITHOUT a country must
					// resolve against the row's STORED country, not the CA∪US fallback: a
					// region-only patch could otherwise store a US state code on a CA row,
					// and a bare (no-`+`) phone could be falsely coerced to +1 on a
					// non-NANP row. A missing row skips the lookup — updateLocations reports
					// it in not_found_ids and the patch is never applied.
					const needsStoredCountry =
						country === undefined &&
						(region !== undefined ||
							(postcode !== undefined && postcode !== null) ||
							(phone !== undefined && phone !== null));
					const storedCountry = needsStoredCountry ? (await getStored(id))?.country : undefined;
					return {
						id,
						...patch,
						// `phone: null` clears it; a value is stored canonical (E.164). NANP
						// inference is scoped to the effective country (patch's, else the row's
						// stored one), so a `+`-less number on a non-NANP venue stays as given.
						...(phone !== undefined
							? {
									phone:
										phone === null
											? null
											: normalizePhone(phone, normalizeCountry(country) ?? storedCountry)
								}
							: {}),
						...normalizeAddressPatch({ street, city, region, postcode, country }, storedCountry)
					};
				})
			);
			const { updatedIds, notFoundIds } = await updateLocations(getDb(), patches);
			return {
				updated: updatedIds.length,
				updated_ids: updatedIds,
				not_found_ids: notFoundIds
			};
		}
	}),
	defineTool({
		name: 'delete_locations',
		annotations: DESTRUCTIVE,
		outputSchema: deleteLocationsOutput,
		description:
			'HARD-delete one or more location rows in a single batch (1-100 ids), mirroring the batched ' +
			"update_locations. Each delete cascades that row's per-item overrides and any user " +
			"LIKES (liked_locations), and deletes the venue's PRIVATE menu — with its items and sources — " +
			'when no other location references it (a shared brand menu is never touched). PREFER close_location for a real ' +
			'venue that has permanently closed — that preserves the likes and keeps the record for analysis; ' +
			'reserve delete for mistaken/duplicate rows that should never have existed. Ids matching no row ' +
			'come back in `not_found_ids`. Returns { deleted, deleted_ids, not_found_ids } (deleted = count ' +
			'actually removed).',
		schema: deleteLocationsArgs,
		handler: ({ ids }) => deleteLocationsBatch(getDb(), ids)
	}),
	defineTool({
		name: 'close_location',
		annotations: DESTRUCTIVE,
		description:
			'Mark a location that is ALREADY on the map as PERMANENTLY CLOSED (soft-delete), or reopen one. ' +
			'The row is kept — so its user likes and menu survive for analysis — and simply hidden ' +
			'from the map, search, list_locations, get_location and the coverage stats; it still blocks ' +
			're-creation and search_poi re-suggestion, so a closed venue never resurfaces to waste research ' +
			'time. Pass `reason` (closure evidence, INCLUDING the source link) to record it; pass `reopen: true` ' +
			'to bring it back. Returns { closed: true } / { reopened: true }, or { not_found: true } if no ' +
			'such id. For a venue NOT yet on the map that you have verified is closed, use create_locations ' +
			'with `closed_reason` instead (a born-closed tombstone) rather than adding it and closing it.',
		schema: closeLocationArgs,
		handler: async ({ id, reason, reopen }) => {
			const ok = reopen
				? await setLocationClosed(getDb(), id, null, null)
				: await setLocationClosed(getDb(), id, Date.now(), reason ?? null);
			if (!ok) return { closed: false, not_found: true, id };
			return reopen ? { reopened: true, id } : { closed: true, id };
		}
	}),
	defineTool({
		name: 'create_items',
		annotations: CREATE,
		outputSchema: createItemsOutput,
		description:
			'Create one or more menu items in a single transaction (all-or-nothing): if any item is invalid, ' +
			'none are written. Target EITHER an independent venue (pass `location_id` — items go on its own ' +
			'private menu, created on first use) OR a shared brand menu (pass `menu_id` — items appear at every ' +
			'branch serving it); pass exactly one. Pass a one-element `items` array to add a single item. Tip: ' +
			'when creating the venue too, pass the items inline as `menu_items` on create_locations to do it in ' +
			'one call. Returns { created, item_ids, skipped_existing_ids, name_collisions } — ids already present ' +
			'are skipped (retries are safe); `name_collisions` lists incoming names that already exist on the ' +
			'target menu so you can update the existing item instead of duplicating it. Read full items with ' +
			'get_item / get_location / get_menu if needed. (Provenance is menu-level: cite the menu with ' +
			'create_menu / update_menu, or via create_locations inline for an independent venue — not per item.)',
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
									optionalTags: it.optional_tags
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
									optionalTags: it.optional_tags
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
		outputSchema: getItemOutput,
		description:
			"Get any menu item by id — a venue's own item or a chain's shared one — with its tags " +
			"(dietary, course). Provenance is menu-level — read a menu's sources with get_menu. To browse a " +
			"venue's items use get_location; " +
			'for a chain menu use get_menu. Returns null if not found.',
		schema: idArgs,
		handler: async ({ id }) => getItemById(getDb(), id)
	}),
	defineTool({
		name: 'update_items',
		annotations: DESTRUCTIVE,
		outputSchema: updateItemsOutput,
		description:
			'Update one or more menu items by id in a single atomic batch — pass a one-item `items` array to ' +
			'edit one. Each patch carries an `id` plus only the fields to change; editing a shared chain item ' +
			'changes it for EVERY branch serving its menu — for a one-branch difference use ' +
			'set_location_item_override instead. Tag edits come in two shapes. PREFER the MERGE ops for ' +
			'incremental edits — `add_tags` / `add_optional_tags` / `remove_tags` change only the tags ' +
			'named, so a second pass (a section footnote, one corrected tag) can never wipe tags it did ' +
			'not restate. The REPLACE sets remain for full rewrites: `tags` replaces the whole required ' +
			'dietary/course set and `optional_tags` the whole optional set — omitting one leaves it ' +
			'untouched (pass `[]` to clear a set; pass both to replace everything). A replace that drops a ' +
			'previously-present dietary tag is flagged in `warnings` (dietary tags are source-asserted; ' +
			'review every such warning — if the drop was unintended, re-add via add_tags). (Provenance is ' +
			'menu-level — edit sources with update_menu, not per item.) Ideal for menu-wide ' +
			'corrections in one call. Ids that do not exist are reported in `not_found_ids`. ' +
			'Returns { updated, updated_ids, not_found_ids, warnings? }.',
		schema: updateItemsArgs,
		handler: async ({ items }) => {
			// Validate any menu MOVE before writing: the target must exist and stay
			// within the item's own brand — never another venue's private menu or
			// another brand's shared menu (see assertItemMenuMoves).
			await assertItemMenuMoves(getDb(), items);
			const patches = items.map(
				({ id, optional_tags, add_tags, add_optional_tags, remove_tags, ...patch }) => ({
					id,
					...patch,
					optionalTags: optional_tags,
					addTags: add_tags,
					addOptionalTags: add_optional_tags,
					removeTags: remove_tags
				})
			);
			const { updatedIds, notFoundIds, warnings } = await updateItems(getDb(), patches);
			return {
				updated: updatedIds.length,
				updated_ids: updatedIds,
				not_found_ids: notFoundIds,
				...(warnings.length ? { warnings } : {})
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
		name: 'create_chain',
		annotations: CREATE,
		outputSchema: createChainOutput,
		description:
			'Bootstrap a chain in ONE call: create the brand, one regional menu under it, and that ' +
			"menu's shared items — the create_brand -> create_menu -> create_items sequence bundled " +
			'(mirroring how create_locations takes inline menu_items). Pass `items: []` to scaffold just ' +
			'the brand + menu and add the items later with create_items (using the returned menu_id). Then ' +
			'point branches at the menu with import_chain (preferred) or create_locations. Idempotent on ' +
			'explicit brand/menu ids (an existing id is a no-op, reported in `already_existed`) and flags a ' +
			'same-name brand/menu in `warnings`, so retries are safe. Returns { brand_id, menu_id, ' +
			'item_ids, created_items, already_existed?, warnings? }. If a stage fails mid-sequence the error ' +
			'reply carries the committed ids (partial_failure) — re-run passing those ids back (no-ops) to ' +
			'resume.',
		schema: createChainArgs,
		handler: (input) => {
			// Provenance is menu-level: the chain's shared menu must cite at least one source link.
			assertHasSource(input.menu.sources, `menu "${input.menu.name}"`);
			return createChainBundle(getDb(), {
				brand: input.brand,
				menu: {
					name: input.menu.name,
					region: input.menu.region,
					currency: input.menu.currency,
					refresh_notes: input.menu.refresh_notes,
					sources: normalizeSources(input.menu.sources),
					id: input.menu.id
				},
				items: input.items.map((it) => ({
					id: it.id,
					item_name: it.item_name,
					description: it.description ?? null,
					price: it.price ?? null,
					tags: it.tags,
					optionalTags: it.optional_tags
				}))
			});
		}
	}),
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
			return {
				id,
				already_existed: false,
				...(warnings.length ? { warnings } : {})
			};
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
		outputSchema: getBrandOutput,
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
			`\`currency\` so item prices are unambiguous (defaults to ${DEFAULT_CURRENCY}). Cite the menu via ` +
			'`sources` — AT LEAST ONE link is required (the menu / ordering link, official nutrition or dietary ' +
			'page) — and bank HOW to re-fetch it in `refresh_notes` (feed ' +
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
			// Provenance is menu-level: a new menu must cite at least one source link.
			assertHasSource(input.sources, `menu "${input.name}"`);
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
			return {
				id,
				already_existed: false,
				...(warnings.length ? { warnings } : {})
			};
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
		outputSchema: getMenuOutput,
		description:
			"Get a menu with its own source URLs and `refresh_notes` (HOW to re-fetch the menu's source — " +
			'read these before re-researching a menu from scratch). `view` picks the payload size and ' +
			'DEFAULTS to "names" — each item as just { id, item_name, price, tags } — so a large shared ' +
			'chain menu is not returned in full unless asked. Pass view: "full" to get every item WITH its ' +
			'description, sources and optional-tag detail (REQUIRED to verify dietary tags or read ' +
			'descriptions); "summary" returns no item list, just counts (item_count, a per-tag histogram, ' +
			'how many items have a price). Each full-view item omits the menu-level ' +
			'`currency`/`menu_id`, which the menu itself carries once. Returns null if not found.',
		schema: getMenuArgs,
		handler: async ({ id, view }) => {
			const menu = await getMenuWithItems(getDb(), id);
			if (!menu) return null;
			if (view === 'summary') {
				const { items, ...meta } = menu;
				return { ...meta, ...menuItemsSummary(items) };
			}
			if (view === 'full') {
				// The menu already carries its id + currency; drop the identical per-item copies.
				return { ...menu, items: menu.items.map(itemWithinParent) };
			}
			// DEFAULT "names" (view undefined or "names"): lean id/item_name/price/tag-ids per item.
			return { ...menu, items: menu.items.map(itemNameView) };
		}
	}),
	defineTool({
		name: 'update_menu',
		annotations: DESTRUCTIVE,
		description:
			'Update a menu (including its `currency` and `refresh_notes` — bank a newly discovered feed ' +
			'endpoint here). Only provided fields change; if `sources` is given it ' +
			'replaces the whole source set (pass [] to clear), or use `add_sources` to append one. Any update ' +
			"also refreshes the menu's `last_verified` date to today automatically — unless " +
			'`stamp_verified: false`, which banks the edit without claiming the menu was re-verified. ' +
			'Returns the updated menu, or null if the id does not exist.',
		schema: updateMenuArgs,
		handler: async ({ id, sources, add_sources, stamp_verified, ...patch }) => {
			assertSourcesNotBoth(sources, add_sources, id);
			if (patch.brand_id && !(await getBrandById(getDb(), patch.brand_id))) {
				throw new Error(`No brand with id "${patch.brand_id}".`);
			}
			return updateMenu(getDb(), id, {
				...patch,
				sources: normalizeSources(sources),
				addSources: normalizeSources(add_sources),
				stampVerified: stamp_verified
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
			'or null for bars/pubs/ice_cream/food_court — pick the best fit), ' +
			'phone/website/cuisine/opening_hours where known (from OSM tags, or Overture-filled — ' +
			'then `phone_source`/`website_source` is non-null), and structured `address_parts` ' +
			"(the POI's own OSM tags, enrichment feeds, and admin-boundary city/region merged — exactly " +
			'what an import stores). A candidate flagged `no_overture_match: true` has NO banked Overture ' +
			'counterpart: Meta/Foursquare/Microsoft collectively carry no record of a name-related venue ' +
			'within ~100 m (~29% of Canadian staging POIs) — an elevated-staleness hint that RAISES the ' +
			'priority of the check-open/closed-before-researching step, NOT proof of closure (match-radius ' +
			'artifacts exist); the flag only appears when the store has been Overture-enriched. ' +
			'Pass `compact: true` for large sweeps (minimal shape, fits 200 ' +
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
						// The staleness hint matters MOST on the large sweeps compact serves.
						...(c.no_overture_match ? { no_overture_match: true } : {}),
						...(c.distance_m === undefined ? {} : { distance_m: c.distance_m })
					};
				})
			};
		}
	}),
	defineTool({
		name: 'search_overture_leads',
		annotations: READ_ONLY,
		description:
			'Query the Overture LEADS pool: Canadian Overture Places eateries (confidence >= 0.85) with NO ' +
			'name-related OSM staging POI within 500 m — a sized feed of venues likely missing from both ' +
			'OSM and the map, heavy in chain units OSM rarely maps (Subway, Bento Sushi, Pizza Hut…). Reads ' +
			'the `overture_leads` table inside the local staging store, built by ' +
			'`bun scripts/overture/build-leads.ts` (rebuild + restart this server to refresh); near-duplicate ' +
			'Overture rows are pre-collapsed and `dup_count` says how many one lead represents. Leads within ' +
			'500 m of a name-related venue already RECORDED in D1 are dropped at query time — open venues ' +
			'AND closed tombstones alike (a closed record deliberately blocks re-suggestion per the closed-' +
			'venue policy; the record may postdate the table build). Set exclude_existing=false to see all. ' +
			'Filters: an optional ' +
			'area (`bbox`, or latitude+longitude+radius_km — nearest-first with `distance_m`; no area = whole ' +
			'pool, best-confidence-first), `city`/`province`, `name` (matches brand_name too) and ' +
			'`brands_only`. JUNK GUARD: independents (no brand_wikidata/brand_name) default to confidence ' +
			'>= 0.9 instead of 0.85, because miscategorized non-eateries concentrate in the unbranded ' +
			'0.85–0.9 band (e.g. most "Wine Rack" wine-retail units) — pass `min_confidence` explicitly to ' +
			'override for every row. Paged via limit/offset like list_locations. POLICY: a lead is a ' +
			'RESEARCH CANDIDATE, not an importable venue — its position/address are Overture-sourced and ' +
			'must NEVER be passed to create_locations (locations are OSM-coordinate-exact). The position is ' +
			'therefore returned as `approx_latitude`/`approx_longitude`, field names create_locations will ' +
			'never accept. Workflow per ' +
			'lead: verify the venue is real and open, find its OSM node (or add one to OSM), get it into the ' +
			'staging store, then import via the `osm_id` (search_poi + create_locations, or import_chain for ' +
			'chains).',
		schema: searchOvertureLeadsArgs,
		handler: async (input) => {
			const db = input.exclude_existing === false ? null : getDb();
			return searchOvertureLeads(getLeadsStore(), db, {
				bbox: input.bbox ? toBounds(input.bbox) : undefined,
				latitude: input.latitude,
				longitude: input.longitude,
				radius_km: input.radius_km,
				city: input.city,
				province: input.province,
				name: input.name,
				min_confidence: input.min_confidence,
				brands_only: input.brands_only,
				exclude_existing: input.exclude_existing,
				limit: input.limit,
				offset: input.offset
			});
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
			'unlinked_existing?, excluded_foreign?, matched_by_brand?, skipped_duplicate_locations, ' +
			'skipped_invalid, warnings, name_buckets, remaining_beyond_max, scan_truncated }. ' +
			'`unlinked_existing` lists venues already on the map at a branch spot that are NOT linked to this ' +
			'chain (an independent or other-brand lookalike import excluded but never adopted, e.g. a stray ' +
			'A&W on a stale private menu) — verify, then adopt with update_locations onto the shared menu. ' +
			'If a D1 failure interrupts the import ' +
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
				country: input.country,
				brandId: input.brand_id
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
					...(selection.unlinked_existing.length
						? { unlinked_existing: selection.unlinked_existing }
						: {}),
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
					(poi): CreateLocationInput => ({
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
					res = await createLocationsBatch(getDb(), getOsmStore(), items, {
						skipInvalid: true
					});
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
				...(selection.unlinked_existing.length
					? { unlinked_existing: selection.unlinked_existing }
					: {}),
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
		outputSchema: auditLocationsOutput,
		description:
			'Audit existing locations and surface a work-list. `check` selects the audit: "coordinate_drift" ' +
			"(stored coordinates that do NOT coincide with the location's OSM POI — fix with " +
			'update_locations), "identity_drift" (the staging POI at a location\'s exact coordinates was ' +
			'RENAMED to a new occupant or is gone — the venue likely moved, closed or was replaced; verify, ' +
			'then close_location / update_locations / import the new occupant; renames that are only a ' +
			'spelling/word-order variant of our name are auto-folded into `counts.cosmetic_renames`, never ' +
			'flagged), "missing_address" (empty or ' +
			'streetless addresses, with the OSM address to ' +
			'backfill where available), "duplicate_locations" (same-name/same-brand pairs within a small ' +
			"radius — probably one venue stored twice; verify against the venue's own locator, then EITHER " +
			'delete_locations the extra row OR dismiss a confirmed two-real-venues pair), ' +
			'"empty_menu" (open venues whose effective menu is ' +
			'empty or thinner than `min_items` — they violate the EXHAUSTIVE-menu policy; backfill with ' +
			'create_items), "html_entities" (text still carrying HTML-encoded references like "&amp;" — ' +
			'ingestion decodes these, so any hit is legacy/anomalous data; fix with the matching update tool), ' +
			'or "missing_course_tag" (items with no required course tag — food/dessert/drink; per the course-' +
			'tag mandate this means the item was never course-reviewed, NOT that it defaults to "food". PAGED ' +
			'via `limit`/`offset`, since the pre-mandate backlog is large; each entry carries a heuristic ' +
			'`hint` to verify, not to auto-apply; fix by re-tagging with update_items), ' +
			'"no_drinks_menu" (open restaurants with a populated menu but zero drink items — the tell that ' +
			'a separate drinks/happy-hour/brunch PAGE was missed during menu research; re-read the site nav ' +
			'and ingest the missed pages), ' +
			'or "unlinked_chain_branch" (INDEPENDENT venues whose name matches an existing chain, a branch ' +
			'never linked to its chain, so it serves a stale private menu instead of the shared chain menu; ' +
			'adopt with update_locations onto the shared menu, or delete_locations a bad row). ' +
			'The address/coordinate checks compare against the LOCAL OSM staging store; the other checks read ' +
			'only the live D1. ' +
			'Results are worst-first / actionable-first; `limit` caps how many are returned and `additional` ' +
			"is how many more exist beyond it. See the `check` field for each mode's entry shape and which " +
			'options apply. Every entry carries a `dismiss_key`: when a finding is VERIFIED to be not a ' +
			'problem, record that once with dismiss_audit_finding and every future run suppresses it ' +
			'(counted in `suppressed_dismissed`) until its evidence materially changes; pass ' +
			'`include_dismissed: true` to review suppressed findings. Findings that ARE problems need no ' +
			'dismissal — fixing them unflags them.',
		schema: auditLocationsArgs,
		handler: async (input) => {
			// Every check suppresses its recorded dismissals (audit_dismissals) the
			// same way; load this check's map once and hand it to the finder.
			const dismissal = {
				dismissals: await auditDismissals(getDb(), input.check),
				include_dismissed: input.include_dismissed
			};
			if (input.check === 'coordinate_drift') {
				return findCoordinateDrift(getOsmStore(), getDb(), {
					limit: input.limit,
					tolerance_m: input.tolerance_m,
					search_radius_m: input.search_radius_m,
					include_unmatched: input.include_unmatched,
					...dismissal
				});
			}
			if (input.check === 'identity_drift') {
				return findIdentityDrift(getOsmStore(), getDb(), {
					limit: input.limit,
					tolerance_m: input.tolerance_m,
					search_radius_m: input.search_radius_m,
					include_vanished: input.include_vanished,
					...dismissal
				});
			}
			if (input.check === 'duplicate_locations') {
				// Discovery reads only the live D1; the staging store — when present —
				// only enriches evidence (the same_phone_staging fallback), so its
				// absence degrades gracefully instead of failing the check.
				return findDuplicateLocations(getDb(), {
					radius_m: input.radius_m,
					limit: input.limit,
					brand_id: input.brand_id,
					store: tryGetOsmStore(),
					...dismissal
				});
			}
			if (input.check === 'empty_menu') {
				// Reads only the live D1 — no staging store needed.
				return findIncompleteMenus(getDb(), {
					min_items: input.min_items,
					limit: input.limit,
					...dismissal
				});
			}
			if (input.check === 'html_entities') {
				// Reads only the live D1 — no staging store needed.
				return findHtmlEntities(getDb(), { limit: input.limit, ...dismissal });
			}
			if (input.check === 'missing_course_tag') {
				// Reads only the live D1 — no staging store needed.
				return findMissingCourseTags(getDb(), {
					limit: input.limit,
					offset: input.offset,
					...dismissal
				});
			}
			if (input.check === 'no_drinks_menu') {
				// Reads only the live D1 — no staging store needed.
				return findNoDrinksMenus(getDb(), {
					min_items: input.min_items,
					limit: input.limit,
					...dismissal
				});
			}
			if (input.check === 'unlinked_chain_branch') {
				// Reads only the live D1 — no staging store needed.
				return findUnlinkedChainBranches(getDb(), {
					limit: input.limit,
					...dismissal
				});
			}
			return findMissingAddress(getOsmStore(), getDb(), {
				limit: input.limit,
				search_radius_m: input.search_radius_m,
				include_incomplete: input.include_incomplete,
				include_unfixable: input.include_unfixable,
				...dismissal
			});
		}
	}),
	defineTool({
		name: 'dismiss_audit_finding',
		annotations: CREATE,
		description:
			'Record the verdict that an audit_locations finding is NOT a problem — a flagged duplicate pair ' +
			'verified as two REAL venues, a renamed/vanished staging POI whose venue is confirmed still ' +
			'operating, a venue with genuinely no street address — so every future run of that check ' +
			'suppresses it (counted in `suppressed_dismissed`) and the verification work is never re-paid. ' +
			"Pass the finding's `dismiss_key` VERBATIM from the audit output: it embeds the evidence " +
			'fingerprint, so the dismissal holds exactly while that evidence holds (e.g. the same occupant ' +
			"name; a later re-tag to a different name re-flags). Use ONLY after verifying against the venue's " +
			'own site/locator or equally strong evidence, and put that evidence in `reason`. One dismissal ' +
			'per finding subject and check; re-dismissing replaces the fingerprint/reason (also how to ' +
			'refresh one after its evidence changed). Pass `revoke: true` to withdraw it. A finding that IS ' +
			'a problem needs no dismissal — fix it (delete_locations the duplicate row, backfill the ' +
			'address, re-tag the item) and it unflags itself.',
		schema: dismissAuditFindingArgs,
		handler: async (input) => {
			const parsed = splitDismissKey(input.dismiss_key);
			if (!parsed) throw new Error('dismiss_key must be "<subject>#<fingerprint>".');
			// Revoke skips the existence check: it can only DELETE a stored row, and
			// the row for a since-deleted/closed subject must stay revocable.
			const subject = await validateDismissSubject(input.check, parsed.subject, !input.revoke);
			if (input.revoke) {
				const revoked = await undismissAuditFinding(getDb(), input.check, subject);
				return { revoked };
			}
			const reason = input.reason?.trim();
			if (!reason) throw new Error('A `reason` (the verification evidence) is required.');
			const res = await dismissAuditFinding(
				getDb(),
				input.check,
				subject,
				parsed.fingerprint,
				reason
			);
			return { dismissed: true, already_dismissed: res.already_dismissed };
		}
	})
] as const;

/**
 * Resolves a dismiss_key subject: strict shape validation always (a malformed
 * or non-canonical subject would store an inert dismissal that suppresses
 * nothing, silently), plus — when `requireExists` — an existence check against
 * the rows it references. Existence is CLOSED-INCLUSIVE (existingIds, not the
 * open-only getLocationById): the html_entities audit flags closed venues too,
 * and their emitted keys must stay dismissable. Returns the subject in
 * canonical form (duplicate pairs ordered).
 */
async function validateDismissSubject(
	check: v.InferOutput<typeof AUDIT_CHECKS_SCHEMA>,
	subject: string,
	requireExists: boolean
): Promise<string> {
	const requireRow = async (table: 'locations' | 'items' | 'menus' | 'brands', id: string) => {
		if (!requireExists) return;
		const found = await existingIds(getDb(), table, [id]);
		if (!found.has(id)) throw new Error(`No ${table.replace(/s$/, '')} with id "${id}".`);
	};
	switch (check) {
		case 'duplicate_locations': {
			const ids = subject.split('|');
			if (ids.length !== 2 || ids[0] === ids[1] || ids.some((id) => !id)) {
				throw new Error(
					'A duplicate_locations subject is the flagged pair as "<location_id>|<location_id>".'
				);
			}
			await Promise.all(ids.map((id) => requireRow('locations', id)));
			return orderedPair(ids[0], ids[1]).join('|');
		}
		case 'missing_course_tag': {
			await requireRow('items', subject);
			return subject;
		}
		case 'html_entities': {
			const parts = subject.split(':');
			const [kind, id, field] = parts;
			if (kind === 'item') {
				if (parts.length !== 3 || !id || (field !== 'item_name' && field !== 'description')) {
					throw new Error('An html_entities item subject is "item:<id>:item_name|description".');
				}
				await requireRow('items', id);
				return subject;
			}
			if (
				(kind === 'location' || kind === 'menu' || kind === 'brand') &&
				parts.length === 2 &&
				id
			) {
				await requireRow(`${kind}s`, id);
				return subject;
			}
			throw new Error(
				'An html_entities subject is "item:<id>:<field>", "location:<id>", "menu:<id>" or "brand:<id>".'
			);
		}
		default: {
			// The remaining checks all flag a single location.
			await requireRow('locations', subject);
			return subject;
		}
	}
}

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
		// Advertised only for the tools that declare one (object-returning); the JSON
		// Schema shares the same valibot→JSON helper, so it stays open/permissive.
		...(t.outputSchema
			? { outputSchema: inputSchemaFor(t.outputSchema) as Tool['outputSchema'] }
			: {}),
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
		// Keep the text content block for backward compatibility (older clients read
		// only text); ADDITIONALLY attach structuredContent when the result is a plain
		// JSON object — the MCP spec requires structuredContent to be an object, so a
		// null (get_* not-found), array (list_brands/list_menus) or primitive stays text-only.
		const structured =
			result !== null && typeof result === 'object' && !Array.isArray(result)
				? { structuredContent: result as Record<string, unknown> }
				: {};
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			...structured
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

// Only wire up stdio when run as the entrypoint (bun run db:mcp) — tests import
// this module for its exported schemas and must not capture the test runner's stdio.
if (import.meta.main) {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error('[better-food-map-db] MCP server ready on stdio');
}
