// ---------------------------------------------------------------------------
// valibot OUTPUT schemas advertised by the MCP server as each tool's
// `outputSchema` (and used to attach `structuredContent` to results). Kept in
// their own module so both the server (which advertises them) and the drift test
// (structured-output.test.ts, which validates representative handler results
// against them) consume the SAME source — the advertised schema and the real
// output cannot silently diverge.
//
// PERMISSIVE BY DESIGN. A strict client must never reject a valid response, so:
//   • conditionally-present fields (warnings, skipped_*, name_collisions, the
//     count_only vs paged shapes, per-`view` menu shapes …) are v.optional;
//   • valibot's v.object emits JSON Schema WITHOUT `additionalProperties: false`
//     (verified), so extra fields a schema doesn't list are always allowed — a
//     schema may describe only the guaranteed fields and still accept the rest.
//
// Only OBJECT-returning tools appear here: MCP `outputSchema`/`structuredContent`
// must be a JSON object, so bare-array tools (list_brands, list_menus) and
// null/primitive returns carry no output schema.
// ---------------------------------------------------------------------------

import * as v from 'valibot';

// --- shared leaf shapes -----------------------------------------------------

const sourceOut = v.object({ url: v.string(), label: v.nullable(v.string()) });

const itemTagOut = v.object({
	id: v.string(),
	name: v.string(),
	tag_type: v.string(),
	optional: v.boolean()
});

/** A menu item as returned standalone (get_item): carries menu_id + currency. Provenance is menu-level. */
const fullItemOut = v.object({
	id: v.string(),
	menu_id: v.string(),
	item_name: v.string(),
	tags: v.array(itemTagOut),
	description: v.nullable(v.string()),
	price: v.nullable(v.number()),
	currency: v.string()
});

const overrideOut = v.object({
	location_id: v.string(),
	item_id: v.string(),
	available: v.nullable(v.boolean()),
	price: v.nullable(v.number())
});

const locationOverviewOut = v.object({
	id: v.string(),
	name: v.string(),
	category: v.nullable(v.string()),
	latitude: v.number(),
	longitude: v.number(),
	address: v.string(),
	phone: v.nullable(v.string()),
	website: v.nullable(v.string()),
	opening_hours: v.nullable(v.string()),
	brand_id: v.nullable(v.string()),
	menu_id: v.nullable(v.string()),
	tags: v.array(v.string())
});

const menuSummaryOut = v.object({
	id: v.string(),
	brand_id: v.nullable(v.string()),
	name: v.string(),
	region: v.nullable(v.string()),
	currency: v.string(),
	last_verified: v.nullable(v.string()),
	item_count: v.number(),
	location_count: v.number()
});

// --- read tools -------------------------------------------------------------

/**
 * list_locations has TWO shapes: the paged row list, or `{ count }` under
 * count_only. Every field is optional so both validate against this one schema.
 */
export const listLocationsOutput = v.object({
	locations: v.optional(v.array(locationOverviewOut)),
	returned: v.optional(v.number()),
	has_more: v.optional(v.boolean()),
	limit: v.optional(v.number()),
	offset: v.optional(v.number()),
	count: v.optional(v.number())
});

export const getLocationOutput = v.object({
	id: v.string(),
	name: v.string(),
	category: v.nullable(v.string()),
	latitude: v.number(),
	longitude: v.number(),
	street: v.string(),
	city: v.string(),
	region: v.string(),
	postcode: v.nullable(v.string()),
	country: v.string(),
	address: v.string(),
	phone: v.nullable(v.string()),
	website: v.nullable(v.string()),
	// Raw OSM-syntax weekly hours; the derived table (opening_hours_json) is an
	// app/SQL concern and is not surfaced to agents.
	opening_hours: v.nullable(v.string()),
	brand_id: v.nullable(v.string()),
	menu_id: v.nullable(v.string()),
	// The venue's provenance, resolved from the menu it serves (sources are menu-level).
	sources: v.array(sourceOut),
	// present only when the venue serves items (its private menu's currency)
	currency: v.optional(v.string()),
	// `menu` varies by `view` ("full"/"names" carry different item shapes; "summary"
	// drops it for counts) — kept permissive + optional so every view validates.
	menu: v.optional(v.array(v.object({ id: v.string() }))),
	// "summary" view (mirrors get_menu's summary): counts + tag histogram, no item list.
	item_count: v.optional(v.number()),
	items_with_price: v.optional(v.number()),
	tag_counts: v.optional(v.record(v.string(), v.number())),
	overrides: v.array(overrideOut)
});

export const getItemOutput = fullItemOut;

/**
 * get_menu varies by `view`: "full" and "names" carry `items` (different item
 * shapes), "summary" drops `items` for counts + a tag histogram. The menu meta
 * is common; view-specific fields are optional.
 */
export const getMenuOutput = v.object({
	id: v.string(),
	brand_id: v.nullable(v.string()),
	name: v.string(),
	region: v.nullable(v.string()),
	currency: v.string(),
	last_verified: v.nullable(v.string()),
	refresh_notes: v.nullable(v.string()),
	sources: v.array(sourceOut),
	// "full"/"names" views (item shape differs per view — kept permissive)
	items: v.optional(v.array(v.object({ id: v.string() }))),
	// "summary" view
	item_count: v.optional(v.number()),
	items_with_price: v.optional(v.number()),
	tag_counts: v.optional(v.record(v.string(), v.number()))
});

export const getBrandOutput = v.object({
	id: v.string(),
	name: v.string(),
	website: v.nullable(v.string()),
	logo_url: v.nullable(v.string()),
	menus: v.array(menuSummaryOut)
});

/**
 * audit_locations returns a different shape per `check` (coordinate_drift,
 * identity_drift, missing_address, duplicate_locations, empty_menu,
 * html_entities, missing_course_tag, unlinked_chain_branch). `additional` and
 * `suppressed_dismissed` are the only fields common to all of them; the rest
 * ride through as allowed extras.
 */
export const auditLocationsOutput = v.object({
	additional: v.optional(v.number()),
	suppressed_dismissed: v.optional(v.number())
});

// --- batch-write result shapes ---------------------------------------------

const skippedInvalidOut = v.object({
	name: v.string(),
	osm_id: v.optional(v.string()),
	reason: v.string()
});

export const createLocationsOutput = v.object({
	created: v.number(),
	location_ids: v.array(v.string()),
	items_created: v.number(),
	item_ids: v.array(v.string()),
	skipped_existing_ids: v.array(v.string()),
	skipped_duplicate_locations: v.optional(
		v.array(v.object({ name: v.string(), existing_id: v.nullable(v.string()) }))
	),
	skipped_invalid: v.optional(v.array(skippedInvalidOut)),
	warnings: v.optional(v.array(v.string()))
});

export const updateLocationsOutput = v.object({
	updated: v.number(),
	updated_ids: v.array(v.string()),
	not_found_ids: v.array(v.string())
});

export const createItemsOutput = v.object({
	created: v.number(),
	item_ids: v.array(v.string()),
	skipped_existing_ids: v.array(v.string()),
	name_collisions: v.optional(
		v.array(v.object({ item_name: v.string(), existing_ids: v.array(v.string()) }))
	)
});

export const updateItemsOutput = v.object({
	updated: v.number(),
	updated_ids: v.array(v.string()),
	not_found_ids: v.array(v.string()),
	// present when a replace-path patch dropped a previously-present dietary tag
	warnings: v.optional(v.array(v.string()))
});

/** create_chain: the bundled brand + menu + items result (already_existed/warnings optional). */
export const createChainOutput = v.object({
	brand_id: v.string(),
	menu_id: v.string(),
	item_ids: v.array(v.string()),
	created_items: v.number(),
	already_existed: v.optional(v.object({ brand: v.boolean(), menu: v.boolean() })),
	warnings: v.optional(v.array(v.string()))
});

export const deleteLocationsOutput = v.object({
	deleted: v.number(),
	deleted_ids: v.array(v.string()),
	not_found_ids: v.array(v.string())
});
