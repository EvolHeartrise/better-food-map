// ---------------------------------------------------------------------------
// MCP/ingestion CRUD surface of the D1 data-access layer.
//
// Split out of ./db.ts so the deployed Worker's hot map read path lives in a
// module of its own: everything here — the location/brand/menu/item writes and
// the scripts-only read helpers — is imported ONLY by scripts/ (the MCP server,
// the OSM/Overture tooling and their tests), never by src/. Nothing under src/
// may import this module; the app's reads stay in ./db.ts.
//
// Same conventions as ./db.ts (which this module imports its shared row-mapping
// helpers, types and constants from — the dependency is one-way): every
// function is RUNTIME-AGNOSTIC, taking a `D1Like` handle, so it runs against
// either the Worker's D1 binding or the HTTP-backed client in d1-http.ts. Keep
// it free of `bun:sqlite`, `node:*`, and other non-Worker imports.
// ---------------------------------------------------------------------------

import {
	DEFAULT_CURRENCY,
	escapeLikePattern,
	groupItemTags,
	LOCATION_FIELDS,
	ITEM_FIELDS,
	ITEM_TAG_SELECT,
	type D1Like,
	type D1PreparedLike,
	type Bounds,
	type Category,
	type Tag,
	type TagId,
	type TagType,
	type Source,
	type Location,
	type LocationWithTags,
	type Item,
	type Brand,
	type Menu,
	type MenuWithItems,
	type MenuSummary,
	type LocationItemOverride,
	type ItemRow,
	type ItemTagRow,
	type LocationRow,
	type OverrideRow
} from './db';
import { impliedDietTagIds } from '../tags';
import { formatAddress } from '../address';
import { normalizeOpeningHours, weeklyHoursJson } from '../opening-hours';
import { decodeHtmlEntities } from '../text';

/**
 * Today's date as an ISO `YYYY-MM-DD` string in the LOCAL timezone. Used as the
 * default {@link Menu.last_verified} when a menu is created without one — every
 * menu must carry a verification date (enforced by the triggers in migration
 * 0012), and a just-created menu is "verified as of now". Local (not UTC) so an
 * evening write from the MCP server doesn't stamp tomorrow's date; on the Worker
 * (whose runtime timezone is UTC) the two are identical. The app supplies this
 * rather than a SQLite `DEFAULT (date('now'))`, matching the convention of
 * keeping time out of the schema (see migration 0007).
 */
export function currentVerificationDate(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Statements that stamp each given menu's `last_verified` to today. Every MCP write
 * that adds or changes a menu or its items runs this, so a menu's freshness date
 * always reflects the last time data flowed into it — agents never supply the date
 * by hand (it is not a tool parameter). Ids are de-duplicated, and the valid
 * date satisfies migration 0012's non-empty-`last_verified` trigger. Returns `[]`
 * for an empty id set so callers can splice it into a batch unconditionally.
 */
function touchMenuStmts(db: D1Like, menuIds: Iterable<string>): D1PreparedLike[] {
	const today = currentVerificationDate();
	return [...new Set(menuIds)].map((menuId) =>
		db.prepare(`UPDATE menus SET last_verified = ? WHERE id = ?`).bind(today, menuId)
	);
}

/** A (location, tag) join row used for the location-level tag overview (no `optional`). */
interface LocationTagRow {
	owner_id: string;
	id: string;
	name: string;
	tag_type: TagType;
}

/** Groups (location, tag) join rows into a distinct {@link Tag} list per location. */
function groupLocationTagsDistinct(rows: LocationTagRow[]): Map<string, Tag[]> {
	const byOwner = new Map<string, Tag[]>();
	const seen = new Map<string, Set<string>>();
	for (const row of rows) {
		let list = byOwner.get(row.owner_id);
		let ids = seen.get(row.owner_id);
		if (!list || !ids) {
			list = [];
			ids = new Set();
			byOwner.set(row.owner_id, list);
			seen.set(row.owner_id, ids);
		}
		if (ids.has(row.id)) continue;
		ids.add(row.id);
		list.push({ id: row.id, name: row.name, tag_type: row.tag_type });
	}
	return byOwner;
}

/**
 * Optional server-side filters for {@link getLocationsWithTags}, pushed into SQL
 * so a bounded list doesn't read (and ship) the whole table. `bbox` and
 * `category` narrow the rows; `limit`/`offset` page the name-ordered result, and
 * the joined tag read is keyed to the returned page's ids. A radius query is served by passing the
 * covering `bbox` and refining to the exact circle in the caller, so this layer
 * stays geo-free. With no filter the behaviour is unchanged (every location).
 */
export interface LocationListFilter {
	bbox?: Bounds;
	category?: Category;
	/** Case-insensitive substring match on the location name (LIKE %query%). */
	nameLike?: string;
	/** Only branches of this chain (exact brand_id match). */
	brandId?: string;
	limit?: number;
	offset?: number;
}

/**
 * Builds the WHERE predicates (aliased to `l`) + bind params for a
 * {@link LocationListFilter}. Closed (soft-deleted) venues are always excluded
 * (migration 0015); that literal carries no bind param, so `params` alignment is
 * untouched. Shared by {@link getLocationsWithTags} and {@link countLocations}
 * so a list and its count always agree on which rows qualify.
 */
function locationFilterConds(filter: LocationListFilter): {
	conds: string[];
	params: (string | number)[];
} {
	const conds: string[] = ['l.closed_at IS NULL'];
	const params: (string | number)[] = [];
	if (filter.bbox) {
		conds.push('l.latitude BETWEEN ? AND ?', 'l.longitude BETWEEN ? AND ?');
		params.push(filter.bbox.minLat, filter.bbox.maxLat, filter.bbox.minLng, filter.bbox.maxLng);
	}
	if (filter.category) {
		conds.push('l.category = ?');
		params.push(filter.category);
	}
	if (filter.nameLike && filter.nameLike.trim() !== '') {
		conds.push("l.name LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLikePattern(filter.nameLike.trim())}%`);
	}
	if (filter.brandId) {
		conds.push('l.brand_id = ?');
		params.push(filter.brandId);
	}
	return { conds, params };
}

/** How many OPEN locations match `filter` — the cheap companion to a paged list. */
export async function countLocations(db: D1Like, filter: LocationListFilter = {}): Promise<number> {
	const { conds, params } = locationFilterConds(filter);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM locations l WHERE ${conds.join(' AND ')}`)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function getLocationsWithTags(
	db: D1Like,
	filter: LocationListFilter = {}
): Promise<LocationWithTags[]> {
	// The filter (and its paging) is evaluated exactly once — the location-row
	// read; the tag sub-read is then keyed by the ids that read returned,
	// so its cost is bounded by the PAGE size, not the full filter-match set
	// (the same id-first shape queryMapData uses, #80/#92).
	const { conds, params } = locationFilterConds(filter);
	const whereSql = `WHERE ${conds.join(' AND ')}`;
	// LIMIT/OFFSET are trusted integers → interpolated (matching MAP_RESULT_LIMIT).
	let pagingSql = '';
	if (filter.limit !== undefined) pagingSql = ` LIMIT ${Math.max(0, Math.trunc(filter.limit))}`;
	else if (filter.offset) pagingSql = ' LIMIT -1';
	if (filter.offset) pagingSql += ` OFFSET ${Math.max(0, Math.trunc(filter.offset))}`;

	const { results: locations } = await db
		.prepare(`SELECT ${LOCATION_FIELDS} FROM locations l ${whereSql} ORDER BY l.name${pagingSql}`)
		.bind(...params)
		.all<LocationRow>();
	if (locations.length === 0) return [];

	// One JSON-array bind expanded with json_each — never an `IN (?, …)` list,
	// which would blow D1's ~100 per-query bound-parameter cap on an unpaged read
	// (the `near` path calls this with no limit).
	const idsJson = JSON.stringify(locations.map((l) => l.id));
	const { results: tagRows } = await db
		// Distinct dietary/course tags offered across a location's menu, excluding
		// items it has overridden to unavailable.
		.prepare(
			`SELECT DISTINCT l.id AS owner_id, t.id AS id, t.name AS name, t.tag_type AS tag_type
			 FROM locations l
			 JOIN items i ON i.menu_id = l.menu_id
			 JOIN item_tags it ON it.item_id = i.id
			 JOIN tags t ON t.id = it.tag_id
			 LEFT JOIN location_item_overrides o
				ON o.location_id = l.id AND o.item_id = i.id
			 WHERE l.id IN (SELECT value FROM json_each(?))
				AND l.menu_id IS NOT NULL
				AND t.tag_type IN ('dietary', 'course')
				AND (o.available IS NULL OR o.available <> 0)
			 ORDER BY l.id, t.rowid`
		)
		.bind(idsJson)
		.all<LocationTagRow>();

	const tagsByLocation = groupLocationTagsDistinct(tagRows);

	return locations.map((loc) => ({
		...loc,
		address: formatAddress(loc),
		tags: tagsByLocation.get(loc.id) ?? []
	}));
}

/**
 * The subset of `ids` that already exist as rows in `table`. Lets the MCP create
 * tools make explicit-id inserts idempotent: a caller that retries a batch with
 * the same ids (e.g. after a dropped response) can skip the rows already written
 * instead of failing the whole batch on a primary-key collision.
 */
const EXISTING_IDS_TABLES = new Set(['locations', 'items', 'brands', 'menus']);

export async function existingIds(
	db: D1Like,
	table: 'locations' | 'items' | 'brands' | 'menus',
	ids: string[]
): Promise<Set<string>> {
	// `table` is interpolated into the SQL, so guard it against an allowlist at
	// runtime (the TS union is erased and can't stop a future dynamic caller).
	if (!EXISTING_IDS_TABLES.has(table)) throw new Error(`existingIds: invalid table "${table}".`);
	if (ids.length === 0) return new Set();
	// One JSON-array bind expanded with json_each, never an `IN (?, …)` list: the MCP
	// create tools batch well past D1's ~100 per-query bound-parameter limit (an
	// exhaustive create_items menu can carry hundreds of explicit ids).
	const { results } = await db
		.prepare(`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
		.all<{ id: string }>();
	return new Set(results.map((r) => r.id));
}

/** Canonical key for a coordinate pair, used to match a resolved point to an existing row. */
export function coordinateKey(latitude: number, longitude: number): string {
	return `${latitude},${longitude}`;
}

/**
 * Maps each given coordinate that ALREADY has a location to that location
 * ({@link coordinateKey} → id/name). Because OSM-imported coordinates are stored
 * verbatim, a true duplicate sits at coordinate-identical lat/lon — so this lets
 * create_locations skip re-importing a venue already on the map. Coordinates with
 * no existing location are absent from the map.
 */
export async function existingLocationsAtCoords(
	db: D1Like,
	coords: { latitude: number; longitude: number }[]
): Promise<Map<string, { id: string; name: string }>> {
	const distinct = [
		...new Map(coords.map((c) => [coordinateKey(c.latitude, c.longitude), c])).values()
	];
	if (distinct.length === 0) return new Map();
	// The pairs travel as ONE JSON array of [lat, lng] tuples expanded with json_each —
	// per-pair `(latitude = ? AND longitude = ?)` conditions cost two bound parameters
	// each, so a 100-location create_locations batch would blow D1's ~100 per-query
	// parameter limit. json_extract parses a JSON.stringify'd JS double back to the
	// bit-identical REAL, so the equality stays float-EXACT — the coordinate-identical
	// dedup invariant this function exists for is untouched.
	const pairs = JSON.stringify(distinct.map((c) => [c.latitude, c.longitude]));
	const { results } = await db
		.prepare(
			`SELECT l.id, l.name, l.latitude, l.longitude FROM locations l
			 JOIN json_each(?) j
			   ON l.latitude = json_extract(j.value, '$[0]') AND l.longitude = json_extract(j.value, '$[1]')`
		)
		.bind(pairs)
		.all<{ id: string; name: string; latitude: number; longitude: number }>();
	const out = new Map<string, { id: string; name: string }>();
	for (const r of results) {
		const key = coordinateKey(r.latitude, r.longitude);
		if (!out.has(key)) out.set(key, { id: r.id, name: r.name });
	}
	return out;
}

/**
 * Every OPEN location whose point falls inside `bbox`, as the minimal shape the
 * proximity checks need (near-duplicate warnings on create, the duplicate audit).
 * Callers refine by exact distance/name — this is just the indexed box read.
 */
export async function openLocationsInBbox(
	db: D1Like,
	bbox: Bounds
): Promise<{ id: string; name: string; latitude: number; longitude: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, latitude, longitude FROM locations
			 WHERE closed_at IS NULL AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`
		)
		.bind(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng)
		.all<{ id: string; name: string; latitude: number; longitude: number }>();
	return results;
}

export async function getLocationById(db: D1Like, id: string): Promise<Location | null> {
	const row = await db
		// Closed (soft-deleted) venues are hidden from get_location too (migration 0015);
		// they remain in D1 for analysis and are reopenable via setLocationClosed.
		.prepare(`SELECT ${LOCATION_FIELDS} FROM locations WHERE id = ? AND closed_at IS NULL`)
		.bind(id)
		.first<LocationRow>();
	if (!row) return null;
	return { ...row, address: formatAddress(row) };
}

/** Returns all items of a menu, each with its tags. Provenance is menu-level (see {@link getMenuById}). */
async function getItemsByMenu(db: D1Like, menuId: string): Promise<Item[]> {
	const [{ results: rows }, menuRow, { results: tagRows }] = await Promise.all([
		db
			.prepare(`SELECT ${ITEM_FIELDS} FROM items WHERE menu_id = ? ORDER BY item_name`)
			.bind(menuId)
			.all<ItemRow>(),
		db
			.prepare(`SELECT currency FROM menus WHERE id = ?`)
			.bind(menuId)
			.first<{ currency: string }>(),
		db
			.prepare(
				`SELECT it.item_id AS owner_id, ${ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 JOIN items i ON i.id = it.item_id
				 WHERE i.menu_id = ?
				 ORDER BY t.rowid`
			)
			.bind(menuId)
			.all<ItemTagRow>()
	]);

	const tagsByItem = groupItemTags(tagRows);
	const currency = menuRow?.currency ?? DEFAULT_CURRENCY;
	return rows.map((row) => ({
		...row,
		currency,
		tags: tagsByItem.get(row.id) ?? []
	}));
}

/**
 * Returns a location's OWN items — those on its private menu (brand_id NULL).
 * A chain branch serves a shared brand menu and owns no items of its own, so it
 * yields an empty list (read those items via {@link getMenuWithItems}).
 */
export async function getFoodByLocation(db: D1Like, locationId: string): Promise<Item[]> {
	const owner = await db
		.prepare(
			`SELECT l.menu_id AS menu_id, m.brand_id AS brand_id
			 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
			 WHERE l.id = ?`
		)
		.bind(locationId)
		.first<{ menu_id: string | null; brand_id: string | null }>();
	if (!owner || owner.menu_id === null || owner.brand_id !== null) return [];
	return getItemsByMenu(db, owner.menu_id);
}

/** Returns a single item with its tags, or `null`. Provenance is menu-level (see {@link getMenuById}). */
export async function getItemById(db: D1Like, id: string): Promise<Item | null> {
	const [row, { results: tags }] = await Promise.all([
		db.prepare(`SELECT ${ITEM_FIELDS} FROM items WHERE id = ?`).bind(id).first<ItemRow>(),
		db
			.prepare(
				`SELECT ${ITEM_TAG_SELECT}
				 FROM item_tags it
				 JOIN tags t ON t.id = it.tag_id
				 WHERE it.item_id = ?
				 ORDER BY t.rowid`
			)
			.bind(id)
			.all<ItemTagRow>()
	]);
	if (!row) return null;
	const menuRow = await db
		.prepare(`SELECT currency FROM menus WHERE id = ?`)
		.bind(row.menu_id)
		.first<{ currency: string }>();
	return {
		...row,
		currency: menuRow?.currency ?? DEFAULT_CURRENCY,
		tags: tags.map((t) => ({
			id: t.id,
			name: t.name,
			tag_type: t.tag_type,
			optional: t.optional !== 0
		}))
	};
}

// ---------------------------------------------------------------------------
// Writes — shared item-write helpers
// ---------------------------------------------------------------------------

/** Tag content for one item write (insert or update). Provenance is menu-level, not per item. */
interface ItemContent {
	tags?: TagId[];
	optionalTags?: TagId[];
}

/** A single `item_tags` link statement. */
function linkTagStmt(db: D1Like, itemId: string, tagId: string, optional: 0 | 1): D1PreparedLike {
	return db
		.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional) VALUES (?, ?, ?)`)
		.bind(itemId, tagId, optional);
}

/**
 * Statements that link an item to its curated dietary/course tags, from `tags`
 * (required) and `optionalTags` (the per-edge `optional` flag — e.g. a dish that
 * can be made vegan on request). Tags an asserted stronger diet entails are
 * silently dropped (DIET_TAG_IMPLIES: an asserted vegan strips vegetarian /
 * dairy_free from BOTH sets — a vegan dish "can be made vegetarian" says
 * nothing); the diet filter matches vegan items under the entailed diets via
 * the same closure, so nothing is lost. An optional vegan strips nothing.
 */
function tagLinkStmts(db: D1Like, itemId: string, content: ItemContent): D1PreparedLike[] {
	const implied = impliedDietTagIds((content.tags ?? []).map((id) => ({ id, optional: false })));
	const stmts: D1PreparedLike[] = [];
	for (const tagId of content.tags ?? [])
		if (!implied.has(tagId)) stmts.push(linkTagStmt(db, itemId, tagId, 0));
	for (const tagId of content.optionalTags ?? [])
		if (!implied.has(tagId)) stmts.push(linkTagStmt(db, itemId, tagId, 1));
	return stmts;
}

/** Shape of one item to insert into a given menu. */
export interface ItemInsertSpec extends ItemContent {
	id?: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
}

/**
 * Display text is cleaned of HTML character references on EVERY write (`&amp;` →
 * `&`): menu research scrapes web sources, so encoded entities occasionally leak
 * into item/location/menu/brand names. Decoding at the db funnels covers every
 * ingestion path (MCP tools, chain imports, inline `menu_items`) at once. The
 * html_entities audit should therefore always come back clean.
 */
const cleanText = decodeHtmlEntities;
const cleanTextOrNull = (value: string | null | undefined): string | null =>
	value === null || value === undefined ? null : decodeHtmlEntities(value);

/** Builds the full statement list to insert one item (row + tags). */
function insertItemStmts(
	db: D1Like,
	id: string,
	menuId: string,
	spec: ItemInsertSpec
): D1PreparedLike[] {
	return [
		db
			.prepare(
				`INSERT INTO items (id, menu_id, item_name, description, price) VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				menuId,
				cleanText(spec.item_name),
				cleanTextOrNull(spec.description),
				spec.price ?? null
			),
		...tagLinkStmts(db, id, spec)
	];
}

// ---------------------------------------------------------------------------
// Writes — locations
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertLocations} (one per location). */
export type LocationInsert = Omit<
	Location,
	'id' | 'brand_id' | 'menu_id' | 'address' | 'opening_hours' | 'opening_hours_json'
> & {
	id?: string;
	brand_id?: string | null;
	menu_id?: string | null;
	/**
	 * RAW weekly hours in OSM `opening_hours` syntax; normalized on write and
	 * stored alongside its derived `opening_hours_json` (see
	 * src/lib/opening-hours.ts). The derived column is never taken from the
	 * caller — this layer computes it, so the pair cannot drift.
	 */
	opening_hours?: string | null;
	/**
	 * Provenance for the PRIVATE menu created when `items` are given (sources are
	 * menu-level). Ignored for a chain branch (which shares its menu) or a location
	 * with no inline items (which gets no menu here).
	 */
	menuSources?: Source[];
	/**
	 * Unix-ms timestamp marking this venue PERMANENTLY CLOSED at import time (a
	 * "born-closed" tombstone), or null/undefined for a normal live venue. A closed
	 * row is hidden from every display/browse read but still blocks re-creation and
	 * search_poi re-suggestion. Paired with {@link closed_reason}. Not combined with
	 * `items` — a closed venue has no menu. To close a venue already on the map (and
	 * keep its likes) use {@link setLocationClosed}, not a re-insert.
	 */
	closed_at?: number | null;
	/** Short note with the closure evidence; null/undefined when open. */
	closed_reason?: string | null;
	/**
	 * Currency (ISO-4217, default CAD) for the private menu created when `items` are
	 * given. Ignored for a chain branch (which shares its menu's currency).
	 */
	currency?: string;
	/**
	 * The venue's OWN menu items, created on a private menu in the SAME atomic
	 * batch as the location (independent venues only). Equivalent to a follow-up
	 * {@link insertFoods} call folded in. Must NOT be combined with `brand_id`/
	 * `menu_id` — a chain branch shares its menu rather than owning items.
	 */
	items?: ItemInsertSpec[];
};

/**
 * Inserts many locations (and optionally each venue's own menu items, with the
 * menu's sources) in one atomic batch and returns their ids in input order: either
 * every location is written or, on any error, none are. Pass a single location to
 * add just one. Ideal for backfilling a chain's branches — give each the same
 * `brand_id`/`menu_id` so they all serve the shared menu — or for adding an
 * independent venue and its menu at once via `items`. One call is one db.batch
 * (a single D1 HTTP request), so callers with unbounded input should split it
 * with {@link chunkLocationInserts} first — atomicity then holds per chunk.
 */
export async function insertLocations(db: D1Like, locs: LocationInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const loc of locs) {
		const id = loc.id ?? crypto.randomUUID();
		ids.push(id);
		const name = cleanText(loc.name);
		// Raw hours normalize once; the machine-readable column is always derived
		// from that same value (see LocationInsert.opening_hours).
		const openingHours = normalizeOpeningHours(loc.opening_hours);
		const hasItems = loc.items !== undefined && loc.items.length > 0;
		if (hasItems && (loc.brand_id || loc.menu_id)) {
			throw new Error(
				`Location "${loc.name}" has inline \`items\` but is linked to a chain ` +
					`(brand_id/menu_id). Inline items are for an independent venue's own menu; a chain ` +
					`branch shares its menu — use create_items with a menu_id, or set_location_item_override for a delta.`
			);
		}
		// An independent venue with inline items gets a private menu created in the
		// same batch (id `pm-<location>`, matching resolvePrivateMenus), pointed at by
		// the location's menu_id. The menu row must precede the location INSERT that
		// references it (immediate FK).
		const privateMenuId = hasItems ? `pm-${id}` : null;
		if (privateMenuId) {
			stmts.push(
				db
					.prepare(
						`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, ?)`
					)
					// last_verified is required (migration 0012); a new private menu is
					// verified as of its creation date.
					.bind(privateMenuId, name, loc.currency ?? DEFAULT_CURRENCY, currentVerificationDate())
			);
			// Provenance lives on the menu now: attach the venue's sources to its private menu.
			for (const source of loc.menuSources ?? []) {
				stmts.push(
					db
						.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
						.bind(privateMenuId, source.url, source.label ?? null)
				);
			}
		}
		stmts.push(
			db
				.prepare(
					`INSERT INTO locations (id, name, category, latitude, longitude, street, city, region, postcode, country, phone, website, opening_hours, opening_hours_json, brand_id, menu_id, closed_at, closed_reason)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					name,
					loc.category,
					loc.latitude,
					loc.longitude,
					loc.street,
					loc.city,
					loc.region,
					loc.postcode,
					loc.country,
					loc.phone,
					loc.website,
					openingHours,
					weeklyHoursJson(openingHours),
					loc.brand_id ?? null,
					loc.menu_id ?? privateMenuId,
					loc.closed_at ?? null,
					loc.closed_reason ?? null
				)
		);
		if (privateMenuId) {
			for (const item of loc.items ?? []) {
				stmts.push(...insertItemStmts(db, item.id ?? crypto.randomUUID(), privateMenuId, item));
			}
		}
	}
	await db.batch(stmts);
	return ids;
}

/**
 * How many statements {@link insertLocations} builds for one location: the
 * private-menu row and its menu-source links (only when it has inline `items`),
 * the location row, and per item its row plus one per tag/optional-tag link —
 * counting only the links tagLinkStmts actually emits (entailed-redundant tags
 * are stripped, see DIET_TAG_IMPLIES). Kept next to insertLocations so the
 * count and the statement builder stay in sync (see the parity test in
 * create-locations.test.ts).
 */
export function locationInsertStatementCount(loc: LocationInsert): number {
	const items = loc.items ?? [];
	const hasItems = items.length > 0;
	return (
		(hasItems ? 1 : 0) +
		(hasItems ? (loc.menuSources?.length ?? 0) : 0) +
		1 +
		items.reduce((n, item) => {
			const implied = impliedDietTagIds((item.tags ?? []).map((id) => ({ id, optional: false })));
			const links = [...(item.tags ?? []), ...(item.optionalTags ?? [])].filter(
				(id) => !implied.has(id)
			).length;
			return n + 1 + links;
		}, 0)
	);
}

/**
 * Splits a {@link insertLocations} batch at LOCATION boundaries into chunks of
 * at most `maxStatements` statements each (per {@link locationInsertStatementCount}),
 * so no single db.batch call inlines an unbounded statement list into one D1
 * HTTP request. A location's own statements are never split — its private menu
 * and items must land in the same atomic batch — so one location over the cap
 * by itself gets a chunk of its own. Order is preserved; concatenating the
 * chunks reproduces the input.
 */
export function chunkLocationInserts<T extends LocationInsert>(
	locs: T[],
	maxStatements: number
): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let count = 0;
	for (const loc of locs) {
		const n = locationInsertStatementCount(loc);
		if (current.length && count + n > maxStatements) {
			chunks.push(current);
			current = [];
			count = 0;
		}
		current.push(loc);
		count += n;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

/** Mutable columns of `locations`. */
const LOCATION_COLUMNS = [
	'name',
	'category',
	'latitude',
	'longitude',
	'street',
	'city',
	'region',
	'postcode',
	'country',
	'phone',
	'website',
	'opening_hours',
	'opening_hours_json',
	'brand_id',
	'menu_id'
] as const;

/**
 * A partial update to one location, keyed by id (for {@link updateLocations}).
 * `opening_hours_json` is excluded: it is DERIVED from an `opening_hours` patch
 * by this layer (see {@link locationUpdateStmts}), never set by a caller.
 */
export type LocationPatch = Partial<Omit<Location, 'id' | 'address' | 'opening_hours_json'>> & {
	id: string;
};

/**
 * Statements that apply one location patch: the scalar SET (only the columns
 * present in `patch`). No existence check — {@link updateLocations} resolves which
 * ids exist up front so the whole batch stays a single round trip. Provenance is
 * menu-level, so a location patch never touches sources (use update_menu).
 */
function locationUpdateStmts(db: D1Like, patch: LocationPatch): D1PreparedLike[] {
	// An hours patch writes BOTH columns — the normalized raw string and its
	// derived weekly table — so the pair can never drift (`opening_hours: null`
	// clears both).
	const effective: LocationPatch & { opening_hours_json?: string | null } = { ...patch };
	if (patch.opening_hours !== undefined) {
		const raw = normalizeOpeningHours(patch.opening_hours);
		effective.opening_hours = raw;
		effective.opening_hours_json = weeklyHoursJson(raw);
	}
	const stmts: D1PreparedLike[] = [];
	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of LOCATION_COLUMNS) {
		const value = effective[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : value);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db
				.prepare(`UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`)
				.bind(...values, patch.id)
		);
	}
	return stmts;
}

/**
 * Applies many partial location updates in one atomic batch. Each patch touches
 * only the fields it carries. Ids that don't exist are skipped and reported in
 * `notFoundIds` rather than aborting the batch. Returns which ids were updated and
 * which were not found. Ideal for mass backfills from the address/coordinate
 * audits — one round trip instead of one update call per location.
 */
export async function updateLocations(
	db: D1Like,
	patches: LocationPatch[]
): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
	if (patches.length === 0) return { updatedIds: [], notFoundIds: [] };
	const ids = patches.map((p) => p.id);
	// Single json_each bind: update_locations batches up to 100 patches, at the edge of
	// D1's ~100 per-query bound-parameter limit as an `IN (?, …)` list.
	const { results } = await db
		.prepare(`SELECT id FROM locations WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
		.all<{ id: string }>();
	const existing = new Set(results.map((r) => r.id));

	const updatedIds: string[] = [];
	const notFoundIds: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const patch of patches) {
		if (!existing.has(patch.id)) {
			notFoundIds.push(patch.id);
			continue;
		}
		updatedIds.push(patch.id);
		stmts.push(...locationUpdateStmts(db, patch));
	}
	if (stmts.length > 0) await db.batch(stmts);
	return { updatedIds, notFoundIds };
}

/**
 * Hard-deletes a location. If the venue serves its OWN private menu (brand_id
 * NULL) that no other location references, the menu is deleted with it —
 * cascading away its items, item tags/sources and menu sources — instead of
 * surviving as permanently unreachable rows (menus have no FK back to
 * locations; `locations.menu_id → menus` is ON DELETE SET NULL). A shared
 * brand menu, or a private menu another location still points at, is left
 * untouched. Returns `true` if a location row was removed.
 */
export async function deleteLocation(db: D1Like, id: string): Promise<boolean> {
	// Resolve up front whether this venue's menu would be orphaned by the delete:
	// a private menu (no owning brand) referenced by no OTHER location.
	const orphan = await db
		.prepare(
			`SELECT m.id AS menu_id
			 FROM locations l
			 JOIN menus m ON m.id = l.menu_id
			 WHERE l.id = ?
			   AND m.brand_id IS NULL
			   AND NOT EXISTS (SELECT 1 FROM locations o WHERE o.menu_id = m.id AND o.id <> l.id)`
		)
		.bind(id)
		.first<{ menu_id: string }>();
	if (orphan) {
		// One atomic batch: the location row plus its now-unreferenced private menu
		// (items/item_tags/item_sources/menu_sources cascade from the menu row).
		await db.batch([
			db.prepare(`DELETE FROM locations WHERE id = ?`).bind(id),
			db.prepare(`DELETE FROM menus WHERE id = ?`).bind(orphan.menu_id)
		]);
		return true; // The join above proved the location row existed.
	}
	const res = await db.prepare(`DELETE FROM locations WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

/**
 * Soft-deletes (or reopens) an existing location by flipping its `closed_at`/
 * `closed_reason`, WITHOUT touching the row's likes or menu — the reason a
 * permanently-closed venue is marked rather than {@link deleteLocation}'d (a delete
 * would cascade `liked_locations` away; see migration 0015). Pass `closedAt = null`
 * (and `reason = null`) to reopen. The closure evidence is captured in `reason`
 * (provenance is menu-level now, so there is no per-location source to append).
 * Returns false when no location has that id. For a venue NOT yet on the map, use
 * {@link insertLocations} with `closed_at` set instead (a born-closed tombstone).
 */
export async function setLocationClosed(
	db: D1Like,
	id: string,
	closedAt: number | null,
	reason: string | null
): Promise<boolean> {
	const exists = await db.prepare(`SELECT id FROM locations WHERE id = ?`).bind(id).first();
	if (!exists) return false;
	await db
		.prepare(`UPDATE locations SET closed_at = ?, closed_reason = ? WHERE id = ?`)
		.bind(closedAt, reason, id)
		.run();
	return true;
}

// ---------------------------------------------------------------------------
// Writes — items on a venue's own (private) menu  [create_items, location_id path]
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertFoods}. */
export type FoodInsert = {
	id?: string;
	location_id: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
	tags?: TagId[];
	optionalTags?: TagId[];
};

/**
 * Resolves the private menu each given location writes its own items to, creating
 * one (and pointing the location at it) where the location has no menu yet.
 * Returns a map of location_id → private menu_id, plus the create/link statements
 * to run before the item inserts. Throws if a location is missing, or if it
 * already serves a SHARED brand menu (a chain branch has no per-branch item store
 * — edit the shared menu or use an override instead).
 */
async function resolvePrivateMenus(
	db: D1Like,
	locationIds: string[],
	currency: string = DEFAULT_CURRENCY
): Promise<{ menuByLocation: Map<string, string>; stmts: D1PreparedLike[] }> {
	const menuByLocation = new Map<string, string>();
	const stmts: D1PreparedLike[] = [];
	const owners = await Promise.all(
		locationIds.map((locationId) =>
			db
				.prepare(
					`SELECT l.id AS id, l.name AS name, l.menu_id AS menu_id, m.brand_id AS brand_id
					 FROM locations l LEFT JOIN menus m ON m.id = l.menu_id
					 WHERE l.id = ?`
				)
				.bind(locationId)
				.first<{
					id: string;
					name: string;
					menu_id: string | null;
					brand_id: string | null;
				}>()
		)
	);
	owners.forEach((owner, i) => {
		const locationId = locationIds[i];
		if (!owner) throw new Error(`No location with id "${locationId}".`);
		if (owner.menu_id !== null) {
			if (owner.brand_id !== null) {
				throw new Error(
					`Location "${locationId}" serves a shared chain menu; its menu items are shared across ` +
						`the chain. Edit them with update_items, or record a per-branch difference with ` +
						`set_location_item_override.`
				);
			}
			menuByLocation.set(locationId, owner.menu_id);
			return;
		}
		// No menu yet: create a private one (brand_id NULL) and point the location at it.
		const menuId = `pm-${locationId}`;
		menuByLocation.set(locationId, menuId);
		stmts.push(
			db
				.prepare(
					`INSERT INTO menus (id, brand_id, name, region, currency, last_verified) VALUES (?, NULL, ?, NULL, ?, ?)`
				)
				// last_verified is required (migration 0012); default a new menu to today.
				.bind(menuId, owner.name, currency, currentVerificationDate()),
			db.prepare(`UPDATE locations SET menu_id = ? WHERE id = ?`).bind(menuId, locationId)
		);
	});
	return { menuByLocation, stmts };
}

/**
 * Inserts many items belonging to independent venues (their own private menus),
 * in one atomic batch, returning their ids in input order. A venue with no menu yet
 * gets a private menu created for it automatically; `currency` (default CAD) sets
 * that new menu's currency (ignored for a venue whose private menu already exists).
 */
export async function insertFoods(
	db: D1Like,
	items: FoodInsert[],
	currency: string = DEFAULT_CURRENCY
): Promise<string[]> {
	const locationIds = [...new Set(items.map((it) => it.location_id))];
	const { menuByLocation, stmts: menuStmts } = await resolvePrivateMenus(db, locationIds, currency);

	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [...menuStmts];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		const menuId = menuByLocation.get(item.location_id);
		// resolvePrivateMenus populates an entry for every distinct location_id (or
		// throws), so this is always defined; the guard just narrows the type.
		if (menuId === undefined)
			throw new Error(`No menu resolved for location "${item.location_id}".`);
		stmts.push(...insertItemStmts(db, id, menuId, item));
	}
	// Adding items refreshes each venue's private menu (a brand-new one is created
	// with today already; an existing one is re-stamped here).
	stmts.push(...touchMenuStmts(db, menuByLocation.values()));
	await db.batch(stmts);
	return ids;
}

/**
 * Statements that apply one item patch: the scalar SET (only the columns present
 * in `patch`), plus per-set replacement for the dietary/course tags. Each tag set
 * provided replaces only its own scope — `tags` the required links
 * (`item_tags.optional = 0`), `optionalTags` the optional links (`optional = 1`)
 * — so patching one set never silently wipes the other (dietary tags are
 * source-asserted; `tags: []` clears just the required set). Providing both is a
 * full replace, as before. No existence check — the caller ({@link updateItems})
 * resolves which ids exist up front so a whole batch stays a single round trip.
 * Provenance is menu-level, so an item patch never touches sources.
 */
function itemUpdateStmts(db: D1Like, id: string, patch: ItemUpdate): D1PreparedLike[] {
	const stmts: D1PreparedLike[] = [];

	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	for (const col of ['menu_id', 'item_name', 'description', 'price'] as const) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(
				(col === 'item_name' || col === 'description') && typeof value === 'string'
					? cleanText(value)
					: value
			);
		}
	}
	if (assignments.length > 0) {
		stmts.push(
			db.prepare(`UPDATE items SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
		);
	}

	// Replace the dietary/course tag set(s), scoped to the set(s) actually
	// provided: clear only the patched scope's links (required and/or optional),
	// then re-link the new set (which tagLinkStmts strips of entailed-redundant
	// tags). A tag id named in the patch is also cleared from the OTHER scope —
	// item_tags is keyed (item_id, tag_id), so without that a pre-existing link at
	// the other optionality would make the re-link an INSERT OR IGNORE no-op and
	// the patch's explicit required/optional assertion would be lost.
	if (patch.tags !== undefined || patch.optionalTags !== undefined) {
		const scopes: string[] = [];
		if (patch.tags !== undefined) scopes.push('0');
		if (patch.optionalTags !== undefined) scopes.push('1');
		const patchedTagIds = [...(patch.tags ?? []), ...(patch.optionalTags ?? [])];
		const crossScopeClause =
			patchedTagIds.length > 0 ? ` OR tag_id IN (${patchedTagIds.map(() => '?').join(', ')})` : '';
		stmts.push(
			db
				.prepare(
					`DELETE FROM item_tags WHERE item_id = ?
					 AND (optional IN (${scopes.join(', ')})${crossScopeClause})
					 AND tag_id IN (SELECT id FROM tags WHERE tag_type IN ('dietary', 'course'))`
				)
				.bind(id, ...patchedTagIds)
		);
		stmts.push(...tagLinkStmts(db, id, patch));
	}

	return stmts;
}

// ---------------------------------------------------------------------------
// Brands (chains)
// ---------------------------------------------------------------------------

export async function getBrands(db: D1Like): Promise<Brand[]> {
	const { results } = await db
		.prepare(`SELECT id, name, website, logo_url FROM brands ORDER BY name`)
		.all<Brand>();
	return results;
}

export async function getBrandById(db: D1Like, id: string): Promise<Brand | null> {
	return db
		.prepare(`SELECT id, name, website, logo_url FROM brands WHERE id = ?`)
		.bind(id)
		.first<Brand>();
}

/** Ids of brands whose name matches `name` (case-insensitive). Used to flag a likely duplicate. */
export async function findBrandIdsByName(db: D1Like, name: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM brands WHERE name = ? COLLATE NOCASE ORDER BY id`)
		.bind(name)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

export async function insertBrand(
	db: D1Like,
	brand: Omit<Brand, 'id'> & { id?: string }
): Promise<string> {
	const id = brand.id ?? crypto.randomUUID();
	await db
		.prepare(`INSERT INTO brands (id, name, website, logo_url) VALUES (?, ?, ?, ?)`)
		.bind(id, cleanText(brand.name), brand.website ?? null, brand.logo_url ?? null)
		.run();
	return id;
}

const BRAND_COLUMNS = ['name', 'website', 'logo_url'] as const;

/** Partial update of a brand. Returns the updated row, or `null` if id unknown. */
export async function updateBrand(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Brand, 'id'>>
): Promise<Brand | null> {
	const assignments: string[] = [];
	const values: (string | null)[] = [];
	for (const col of BRAND_COLUMNS) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : (value ?? null));
		}
	}
	if (assignments.length > 0) {
		await db
			.prepare(`UPDATE brands SET ${assignments.join(', ')} WHERE id = ?`)
			.bind(...values, id)
			.run();
	}
	return getBrandById(db, id);
}

/**
 * Deletes a brand and (by cascade) its menus, their items, tag links and menu sources.
 * Any locations referencing it revert to having no menu (`brand_id`/`menu_id` set
 * to NULL by `ON DELETE SET NULL`). Returns `true` if a row was removed.
 */
export async function deleteBrand(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM brands WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** Internal raw shape of a `menus` row before its sources are attached. */
type MenuRow = Omit<Menu, 'sources'>;

const MENU_FIELDS = `id, brand_id, name, region, currency, last_verified, refresh_notes`;

/**
 * Lists brand menus (with an item count), optionally filtered by brand. Private
 * venue menus (brand_id NULL) are an implementation detail and excluded.
 */
export async function getMenus(db: D1Like, brandId?: string): Promise<MenuSummary[]> {
	// location_count = OPEN branches serving the menu, so an audit can see each
	// menu's live footprint without paging list_locations (closed branches keep
	// their menu_id but are off the map — counting them would overstate coverage).
	// Correlated subqueries, not LEFT JOINs: two independent joins would fan out
	// to item_count × location_count rows per menu before GROUP BY collapses them
	// (~1M+ rows_read for a large chain menu); each subquery is a linear index scan.
	const sql =
		`SELECT m.id, m.brand_id, m.name, m.region, m.currency, m.last_verified,
			(SELECT COUNT(*) FROM items i WHERE i.menu_id = m.id) AS item_count,
			(SELECT COUNT(*) FROM locations l WHERE l.menu_id = m.id AND l.closed_at IS NULL)
				AS location_count
		 FROM menus m` +
		(brandId ? ` WHERE m.brand_id = ?` : ` WHERE m.brand_id IS NOT NULL`) +
		` ORDER BY m.name`;
	const stmt = brandId ? db.prepare(sql).bind(brandId) : db.prepare(sql);
	const { results } = await stmt.all<MenuSummary>();
	return results;
}

export async function getMenuById(db: D1Like, id: string): Promise<Menu | null> {
	const [row, { results: sources }] = await Promise.all([
		db.prepare(`SELECT ${MENU_FIELDS} FROM menus WHERE id = ?`).bind(id).first<MenuRow>(),
		db
			.prepare(`SELECT url, label FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(id)
			.all<Source>()
	]);
	if (!row) return null;
	return { ...row, sources };
}

/**
 * Ids of menus belonging to `brandId` whose name matches `name` (case-insensitive).
 * Used to flag a likely duplicate when creating another menu under the same brand.
 */
export async function findMenuIdsByName(
	db: D1Like,
	brandId: string,
	name: string
): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM menus WHERE brand_id = ? AND name = ? COLLATE NOCASE ORDER BY id`)
		.bind(brandId, name)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** Number of items on a menu (0 for a missing menu). */
export async function countMenuItems(db: D1Like, menuId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM items WHERE menu_id = ?`)
		.bind(menuId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Validates a brand/menu pair before linking a location (or a whole chain import)
 * to it. `null`/`undefined` ids are skipped (detaching is always allowed), but a
 * non-null `menuId` is only accepted as a SHARED brand menu with its owning brand
 * passed alongside: a private venue menu (brand_id NULL) is an implementation
 * detail that must never be shared — attaching one would make every linked
 * location display (and edit) that venue's items — and requiring
 * `menu.brand_id === brandId` stops a location from silently joining another
 * brand's menu.
 */
export async function assertBrandMenuRefs(
	db: D1Like,
	brandId: string | null | undefined,
	menuId: string | null | undefined
): Promise<void> {
	if (brandId) {
		if (!(await getBrandById(db, brandId))) throw new Error(`No brand with id "${brandId}".`);
	}
	if (menuId) {
		const menu = await getMenuById(db, menuId);
		if (!menu) throw new Error(`No menu with id "${menuId}".`);
		if (menu.brand_id === null) {
			throw new Error(
				`Menu "${menuId}" is an independent venue's private menu — it cannot be attached to ` +
					`another location or used as a chain menu. Create a shared menu with create_menu ` +
					`(after create_brand) instead.`
			);
		}
		if (!brandId) {
			throw new Error(
				`Menu "${menuId}" is brand "${menu.brand_id}"'s shared menu — pass that brand_id ` +
					`together with menu_id so the branch is linked to its chain.`
			);
		}
		if (menu.brand_id !== brandId) {
			throw new Error(
				`Menu "${menuId}" belongs to brand "${menu.brand_id}", not "${brandId}". ` +
					`Pass the menu's own brand_id.`
			);
		}
	}
}

export async function getMenuWithItems(db: D1Like, id: string): Promise<MenuWithItems | null> {
	const menu = await getMenuById(db, id);
	if (!menu) return null;
	return { ...menu, items: await getItemsByMenu(db, id) };
}

export async function insertMenu(
	db: D1Like,
	menu: Omit<Menu, 'id' | 'sources' | 'currency' | 'last_verified' | 'refresh_notes'> & {
		id?: string;
		currency?: string;
		refresh_notes?: string | null;
		sources?: Source[];
	}
): Promise<string> {
	const id = menu.id ?? crypto.randomUUID();
	const stmts: D1PreparedLike[] = [
		db
			.prepare(
				`INSERT INTO menus (id, brand_id, name, region, currency, last_verified, refresh_notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				menu.brand_id ?? null,
				cleanText(menu.name),
				menu.region ?? null,
				menu.currency ?? DEFAULT_CURRENCY,
				// last_verified is always "now": a just-created menu is verified as of its
				// creation, the date is never an agent-supplied parameter, and a real date
				// satisfies migration 0012's non-empty requirement.
				currentVerificationDate(),
				menu.refresh_notes ?? null
			)
	];
	for (const source of menu.sources ?? []) {
		stmts.push(
			db
				.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
				.bind(id, source.url, source.label ?? null)
		);
	}
	await db.batch(stmts);
	return id;
}

// `last_verified` is excluded: it is never set from the patch, but always stamped
// to today on any update (the menu's data was just re-checked against its source).
const MENU_COLUMNS = ['brand_id', 'name', 'region', 'currency', 'refresh_notes'] as const;

/**
 * Partial update of a menu. Scalar fields present in `patch` are written; if
 * `patch.sources` is given it replaces the whole source set (pass `[]` to clear).
 * Any update also refreshes `last_verified` to today (it is auto-managed, not a
 * patch field). Returns the updated menu, or `null` if no menu has that id.
 */
export async function updateMenu(
	db: D1Like,
	id: string,
	patch: Partial<Omit<Menu, 'id' | 'last_verified'>> & {
		/** Append these sources (dedupe by url), keeping existing ones — vs `sources` which replaces. */
		addSources?: Source[];
	}
): Promise<Menu | null> {
	if (!(await getMenuById(db, id))) return null;

	const stmts: D1PreparedLike[] = [];
	// Always re-stamp last_verified, so even a sources-only edit marks the menu fresh.
	const assignments: string[] = ['last_verified = ?'];
	const values: (string | null)[] = [currentVerificationDate()];
	for (const col of MENU_COLUMNS) {
		const value = patch[col];
		if (value !== undefined) {
			assignments.push(`${col} = ?`);
			values.push(col === 'name' && typeof value === 'string' ? cleanText(value) : (value ?? null));
		}
	}
	stmts.push(
		db.prepare(`UPDATE menus SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id)
	);
	// `sources` replaces the whole set; `addSources` appends (dedupe via the PK).
	const replaceSources = patch.sources !== undefined;
	if (replaceSources) {
		stmts.push(db.prepare(`DELETE FROM menu_sources WHERE menu_id = ?`).bind(id));
	}
	for (const source of (replaceSources ? patch.sources : patch.addSources) ?? []) {
		stmts.push(
			db
				.prepare(`INSERT OR IGNORE INTO menu_sources (menu_id, url, label) VALUES (?, ?, ?)`)
				.bind(id, source.url, source.label ?? null)
		);
	}
	if (stmts.length > 0) await db.batch(stmts);
	return getMenuById(db, id);
}

/**
 * Deletes a menu and (by cascade) its items, their tag links and the menu's sources. Any
 * locations serving it revert to having no menu (`menu_id` set NULL). Returns
 * `true` if a row was removed.
 */
export async function deleteMenu(db: D1Like, id: string): Promise<boolean> {
	const res = await db.prepare(`DELETE FROM menus WHERE id = ?`).bind(id).run();
	return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Audit-finding dismissals (audit_dismissals, migration 0025): a durable
// "this audit finding was reviewed and is NOT a problem" record, so no audit
// re-flags a finding someone already verified (two real venues near each
// other, a cosmetic OSM rename, a POI the staging store lacks). A dismissal
// is keyed by (check, subject) and pins the evidence it judged in
// `fingerprint`: the audits suppress a finding only while they compute the
// SAME fingerprint for that subject — materially new evidence re-flags.
// Findings that are real problems need no dismissal: fixing them (delete the
// duplicate row, backfill the address, re-tag the item) unflags them.
// ---------------------------------------------------------------------------

/** Canonical ordered form of an unordered location pair (a < b). */
export function orderedPair(idA: string, idB: string): [string, string] {
	return idA < idB ? [idA, idB] : [idB, idA];
}

/** One stored dismissal, keyed by (check, subject) in `audit_dismissals`. */
export interface DismissalRecord {
	fingerprint: string;
	reason: string;
	dismissed_at: string;
}

/**
 * Records that an audit finding was verified as not a problem, with the
 * evidence in `reason`. Idempotent: re-dismissing the same (check, subject)
 * replaces the fingerprint/reason and re-stamps the date — which is also how a
 * dismissal is refreshed after the finding's fingerprint changed. Returns
 * whether a dismissal for this subject already existed.
 */
export async function dismissAuditFinding(
	db: D1Like,
	check: string,
	subjectKey: string,
	fingerprint: string,
	reason: string
): Promise<{ already_dismissed: boolean }> {
	const existing = await db
		.prepare(`SELECT 1 AS x FROM audit_dismissals WHERE check_name = ? AND subject_key = ?`)
		.bind(check, subjectKey)
		.first<{ x: number }>();
	await db
		.prepare(
			`INSERT OR REPLACE INTO audit_dismissals
				(check_name, subject_key, fingerprint, reason, dismissed_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.bind(check, subjectKey, fingerprint, reason, currentVerificationDate())
		.run();
	return { already_dismissed: Boolean(existing) };
}

/** Revokes a dismissal (the finding audits normally again). True when a row was deleted. */
export async function undismissAuditFinding(
	db: D1Like,
	check: string,
	subjectKey: string
): Promise<boolean> {
	const res = await db
		.prepare(`DELETE FROM audit_dismissals WHERE check_name = ? AND subject_key = ?`)
		.bind(check, subjectKey)
		.run();
	return res.meta.changes > 0;
}

/** Every dismissal recorded for `check`, keyed by subject (audit suppression). */
export async function auditDismissals(
	db: D1Like,
	check: string
): Promise<Map<string, DismissalRecord>> {
	const { results } = await db
		.prepare(
			`SELECT subject_key, fingerprint, reason, dismissed_at
			 FROM audit_dismissals WHERE check_name = ?`
		)
		.bind(check)
		.all<{ subject_key: string; fingerprint: string; reason: string; dismissed_at: string }>();
	return new Map(
		results.map((r) => [
			r.subject_key,
			{ fingerprint: r.fingerprint, reason: r.reason, dismissed_at: r.dismissed_at }
		])
	);
}

// ---------------------------------------------------------------------------
// Shared menu items (belong to a menu — cf. the create_items location_id path, which adds
// to a venue's own private menu). Both write to the same `items` table. Reading,
// updating and deleting items are id-keyed and menu-agnostic, so they use the
// generic getItemById / updateItems / deleteItem rather than a per-kind variant.
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link insertMenuItems}. */
export type MenuItemInsert = {
	id?: string;
	menu_id: string;
	item_name: string;
	description?: string | null;
	price?: number | null;
	tags?: TagId[];
	optionalTags?: TagId[];
};

/**
 * Inserts many shared menu items in one atomic batch and returns their ids in
 * input order. Mirrors {@link insertFoods}, but items belong to a given menu
 * (shared across every location that serves it) rather than a venue's own menu.
 */
export async function insertMenuItems(db: D1Like, items: MenuItemInsert[]): Promise<string[]> {
	const ids: string[] = [];
	const stmts: D1PreparedLike[] = [];
	for (const item of items) {
		const id = item.id ?? crypto.randomUUID();
		ids.push(id);
		stmts.push(...insertItemStmts(db, id, item.menu_id, item));
	}
	// Adding items is data flowing into each target menu — mark them freshly verified.
	stmts.push(
		...touchMenuStmts(
			db,
			items.map((it) => it.menu_id)
		)
	);
	await db.batch(stmts);
	return ids;
}

/**
 * Of the given item names, those that ALREADY exist on `menuId` (case-insensitive),
 * each with the existing item ids. Lets create_items warn that a
 * re-run or extend would duplicate an item the menu already lists, so an agent can
 * update the existing item instead. Returns `[]` when nothing collides.
 */
export async function itemNameCollisions(
	db: D1Like,
	menuId: string,
	names: string[]
): Promise<{ item_name: string; existing_ids: string[] }[]> {
	const distinct = [...new Set(names)];
	if (distinct.length === 0) return [];
	// Single json_each bind (an exhaustive create_items menu can carry hundreds of
	// names, past D1's ~100 per-query bound-parameter limit). SQLite's IN uses the
	// LEFT operand's collating sequence, so COLLATE NOCASE on item_name keeps the
	// subselect match case-insensitive.
	const { results } = await db
		.prepare(
			`SELECT id, item_name FROM items WHERE menu_id = ? AND item_name COLLATE NOCASE IN (SELECT value FROM json_each(?))`
		)
		.bind(menuId, JSON.stringify(distinct))
		.all<{ id: string; item_name: string }>();
	const idsByLowerName = new Map<string, string[]>();
	for (const r of results) {
		const key = r.item_name.toLowerCase();
		const list = idsByLowerName.get(key) ?? [];
		list.push(r.id);
		idsByLowerName.set(key, list);
	}
	const out: { item_name: string; existing_ids: string[] }[] = [];
	for (const name of distinct) {
		const ids = idsByLowerName.get(name.toLowerCase());
		if (ids?.length) out.push({ item_name: name, existing_ids: ids });
	}
	return out;
}

/** The fields of one item patch (see {@link ItemPatch} / {@link updateItems}). */
export type ItemUpdate = {
	/** Move the item to a different menu (rare). */
	menu_id?: string;
	item_name?: string;
	description?: string | null;
	price?: number | null;
} & ItemContent;

/** A partial update to one item, keyed by id (for {@link updateItems}). */
export type ItemPatch = ItemUpdate & { id: string };

/**
 * Applies one or more partial item updates in one atomic batch, mirroring
 * {@link updateLocations}. For a shared chain item the change applies to EVERY
 * branch serving its menu; for a venue's own item it applies to that venue. Each
 * patch touches only the fields it carries (replace-set semantics; see
 * {@link itemUpdateStmts}). Ids that don't exist are skipped and reported in
 * `notFoundIds` rather than aborting the batch. Returns which ids were updated and
 * which were not found — one round trip instead of a call per item, for menu-wide
 * corrections.
 */
export async function updateItems(
	db: D1Like,
	patches: ItemPatch[]
): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
	if (patches.length === 0) return { updatedIds: [], notFoundIds: [] };
	const ids = patches.map((p) => p.id);
	// Single json_each bind: update_items batches up to 200 patches, double D1's ~100
	// per-query bound-parameter limit as an `IN (?, …)` list.
	const { results } = await db
		.prepare(`SELECT id, menu_id FROM items WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
		.all<{ id: string; menu_id: string }>();
	const menuByItem = new Map(results.map((r) => [r.id, r.menu_id]));

	const updatedIds: string[] = [];
	const notFoundIds: string[] = [];
	const affectedMenus = new Set<string>();
	const stmts: D1PreparedLike[] = [];
	for (const { id, ...patch } of patches) {
		const currentMenu = menuByItem.get(id);
		if (currentMenu === undefined) {
			notFoundIds.push(id);
			continue;
		}
		updatedIds.push(id);
		// The item's current menu is refreshed; a move (patch.menu_id) also touches
		// the destination menu, which just gained the item.
		affectedMenus.add(currentMenu);
		if (patch.menu_id) affectedMenus.add(patch.menu_id);
		stmts.push(...itemUpdateStmts(db, id, patch));
	}
	if (stmts.length > 0) {
		stmts.push(...touchMenuStmts(db, affectedMenus));
		await db.batch(stmts);
	}
	return { updatedIds, notFoundIds };
}

/** Deletes an item and its tag links (and any per-location overrides). Returns `true` if removed. */
export async function deleteItem(db: D1Like, id: string): Promise<boolean> {
	// Resolve the parent menu before the delete so we can mark it freshly verified
	// (removing an item is a reconciliation against the source like any other write).
	const row = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(id)
		.first<{ menu_id: string }>();
	if (!row) return false;
	await db.batch([
		db.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
		...touchMenuStmts(db, [row.menu_id])
	]);
	return true;
}

// ---------------------------------------------------------------------------
// Per-location overrides of menu items
// ---------------------------------------------------------------------------

/** Returns a location's overrides of its menu items (empty if none). */
export async function getLocationItemOverrides(
	db: D1Like,
	locationId: string
): Promise<LocationItemOverride[]> {
	const { results } = await db
		.prepare(
			`SELECT location_id, item_id, available, price
			 FROM location_item_overrides WHERE location_id = ? ORDER BY rowid`
		)
		.bind(locationId)
		.all<OverrideRow>();
	return results.map((r) => ({
		location_id: r.location_id,
		item_id: r.item_id,
		available: r.available === null ? null : r.available !== 0,
		price: r.price
	}));
}

/**
 * Creates or updates a location's override of one menu item as a PARTIAL PATCH:
 * only the fields PRESENT in `override` change. A field left `undefined` keeps its
 * currently-stored value (so toggling just `available` never wipes a previously
 * set `price`, and vice-versa); pass an explicit `null` to reset that field to
 * inherit the menu default. `available` `false` hides the item at this location;
 * `price` overrides its price here.
 */
export async function setLocationItemOverride(
	db: D1Like,
	locationId: string,
	itemId: string,
	override: { available?: boolean | null; price?: number | null }
): Promise<{ available: boolean | null; price: number | null }> {
	// Merge with the existing row so an omitted field is preserved, not cleared.
	const existing = await db
		.prepare(
			`SELECT available, price FROM location_item_overrides WHERE location_id = ? AND item_id = ?`
		)
		.bind(locationId, itemId)
		.first<{ available: number | null; price: number | null }>();
	const available =
		override.available !== undefined
			? override.available === null
				? null
				: override.available
					? 1
					: 0
			: (existing?.available ?? null);
	const price = override.price !== undefined ? (override.price ?? null) : (existing?.price ?? null);
	// Resolve the item's menu so the override (a per-branch delta against it) marks
	// that menu freshly verified, in the same atomic batch as the upsert.
	const menuRow = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(itemId)
		.first<{ menu_id: string }>();
	await db.batch([
		db
			.prepare(
				`INSERT INTO location_item_overrides (location_id, item_id, available, price)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(location_id, item_id)
				 DO UPDATE SET available = excluded.available, price = excluded.price`
			)
			.bind(locationId, itemId, available, price),
		...touchMenuStmts(db, menuRow ? [menuRow.menu_id] : [])
	]);
	// Return the resulting (merged) override so callers can echo accurate state.
	return { available: available === null ? null : available !== 0, price };
}

/** Removes an override so the location inherits the menu default again. */
export async function deleteLocationItemOverride(
	db: D1Like,
	locationId: string,
	itemId: string
): Promise<boolean> {
	const res = await db
		.prepare(`DELETE FROM location_item_overrides WHERE location_id = ? AND item_id = ?`)
		.bind(locationId, itemId)
		.run();
	if (res.meta.changes === 0) return false;
	// Clearing a per-branch delta re-asserts the menu default for it — mark the menu
	// freshly verified, matching the create/update override paths.
	const menuRow = await db
		.prepare(`SELECT menu_id FROM items WHERE id = ?`)
		.bind(itemId)
		.first<{ menu_id: string }>();
	if (menuRow) await db.batch(touchMenuStmts(db, [menuRow.menu_id]));
	return true;
}
