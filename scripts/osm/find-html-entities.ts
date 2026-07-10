// ---------------------------------------------------------------------------
// html_entities audit: display text that still carries HTML-ENCODED character
// references ("Bacon &amp; Egg", "&#39;", "&eacute;") instead of the decoded
// character.
//
// Every ingestion write now decodes entities at the db funnels (cleanText in
// src/lib/server/db.ts), so this audit exists as the regression detector: it
// should always come back empty, and a non-zero result means encoded text
// entered through some path the decoder doesn't cover (or predates it). A
// string is flagged precisely when decodeHtmlEntities would change it — the
// audit and the fix share one definition, so a flagged row is always fixable.
//
// Scanned fields: items.item_name / items.description, locations.name,
// menus.name, brands.name. Each flagged item also carries the locations that
// serve its menu, so the venue-facing blast radius is visible directly.
// Fix flagged rows with update_items / update_locations / update_menu /
// update_brand — passing the `decoded` value re-runs it through the write-path
// decoder, which is a no-op on already-decoded text.
//
// Reads only the live D1 (no OSM store), like find-incomplete-menus. The SQL
// prefilter (`LIKE '%&%;%'` — every entity is "&…;") keeps the fetch small;
// the precise decode-changes-it test runs in JS.
// ---------------------------------------------------------------------------

import { formatAddress } from '../../src/lib/address';
import { decodeHtmlEntities } from '../../src/lib/text';
import type { D1Like } from '../../src/lib/server/db';
import { DismissFilter, fnv1a, type DismissableFinding, type DismissalOpts } from './audit-dismiss';

/** A location serving a menu that carries an encoded item (blast-radius context). */
export interface EncodedItemLocation {
	id: string;
	name: string;
}

/** One flagged menu item (fix with update_items using `decoded`). */
export interface EncodedItem extends DismissableFinding {
	id: string;
	menu_id: string;
	/** Which text field carries the encoded entity. */
	field: 'item_name' | 'description';
	/** The stored (encoded) text. */
	value: string;
	/** What the text should be — decodeHtmlEntities(value). */
	decoded: string;
	/** Locations serving this item's menu (capped at 5). */
	locations: EncodedItemLocation[];
	/** Total locations serving this item's menu (may exceed `locations`). */
	location_count: number;
}

/** One flagged location name (fix with update_locations using `decoded`). */
export interface EncodedLocation extends DismissableFinding {
	id: string;
	name: string;
	decoded: string;
	/** Canonical single-line display address (derived, never stored). */
	address: string;
}

/** One flagged menu/brand name (fix with update_menu / update_brand). */
export interface EncodedName extends DismissableFinding {
	id: string;
	name: string;
	decoded: string;
}

export interface FindHtmlEntitiesResult {
	items: EncodedItem[];
	locations: EncodedLocation[];
	menus: EncodedName[];
	brands: EncodedName[];
	/** All flagged rows across every list (before `limit`). */
	total: number;
	/** How many flagged rows the four lists carry (≤ total). */
	returned: number;
	/** Flagged rows NOT returned because of `limit` (total - returned). */
	additional: number;
	/** Findings a stored dismissal matched (dropped, or annotated under include_dismissed). */
	suppressed_dismissed: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ITEM_LOCATION_CAP = 5;

/** True when the text still carries an HTML character reference the decoder would fix. */
function isEncoded(value: string | null): value is string {
	return value !== null && decodeHtmlEntities(value) !== value;
}

/**
 * Flags every row whose display text still contains an HTML-encoded character
 * reference (exactly: `decodeHtmlEntities` would change it). `limit` (default 50,
 * max 200) caps EACH of the four lists, with anything cut counted in
 * `additional`; `total` is the full flagged count across all of them.
 */
export async function findHtmlEntities(
	db: D1Like,
	opts: { limit?: number } & DismissalOpts = {}
): Promise<FindHtmlEntitiesResult> {
	const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	// Subjects span four tables, so they carry a kind prefix; the fingerprint
	// hashes the stored text — edited text is new evidence.
	const filter = new DismissFilter(opts);

	// Prefilter in SQL — an entity is always "&…;", so '%&%;%' catches every
	// candidate while skipping the vast majority of plain "Fish & Chips" rows.
	const [itemRows, locationRows, menuRows, brandRows] = await Promise.all([
		db
			.prepare(
				`SELECT id, menu_id, item_name, description FROM items
				 WHERE item_name LIKE '%&%;%' OR description LIKE '%&%;%'
				 ORDER BY item_name`
			)
			.all<{
				id: string;
				menu_id: string;
				item_name: string;
				description: string | null;
			}>(),
		db
			.prepare(
				`SELECT id, name, street, city, region, postcode FROM locations
				 WHERE name LIKE '%&%;%' ORDER BY name`
			)
			.all<{
				id: string;
				name: string;
				street: string;
				city: string;
				region: string;
				postcode: string | null;
			}>(),
		db
			.prepare(`SELECT id, name FROM menus WHERE name LIKE '%&%;%' ORDER BY name`)
			.all<{ id: string; name: string }>(),
		db
			.prepare(`SELECT id, name FROM brands WHERE name LIKE '%&%;%' ORDER BY name`)
			.all<{ id: string; name: string }>()
	]);

	// One item row can flag both fields — each encoded field is its own entry.
	const flaggedItems: Omit<EncodedItem, 'locations' | 'location_count'>[] = [];
	for (const row of itemRows.results) {
		for (const field of ['item_name', 'description'] as const) {
			const value = row[field];
			if (isEncoded(value)) {
				const decision = filter.evaluate(`item:${row.id}:${field}`, fnv1a(value));
				if (decision.drop) continue;
				flaggedItems.push({
					id: row.id,
					menu_id: row.menu_id,
					field,
					value,
					decoded: decodeHtmlEntities(value),
					...decision.fields
				});
			}
		}
	}

	const flaggedLocations: EncodedLocation[] = [];
	for (const r of locationRows.results) {
		if (!isEncoded(r.name)) continue;
		const decision = filter.evaluate(`location:${r.id}`, fnv1a(r.name));
		if (decision.drop) continue;
		flaggedLocations.push({
			id: r.id,
			name: r.name,
			decoded: decodeHtmlEntities(r.name),
			address: formatAddress({
				street: r.street,
				city: r.city,
				region: r.region,
				postcode: r.postcode
			}),
			...decision.fields
		});
	}

	const flagNames = (
		rows: { id: string; name: string }[],
		kind: 'menu' | 'brand'
	): EncodedName[] => {
		const out: EncodedName[] = [];
		for (const r of rows) {
			if (!isEncoded(r.name)) continue;
			const decision = filter.evaluate(`${kind}:${r.id}`, fnv1a(r.name));
			if (decision.drop) continue;
			out.push({
				id: r.id,
				name: r.name,
				decoded: decodeHtmlEntities(r.name),
				...decision.fields
			});
		}
		return out;
	};
	const flaggedMenus = flagNames(menuRows.results, 'menu');
	const flaggedBrands = flagNames(brandRows.results, 'brand');

	// Blast radius for the returned items: which locations serve each flagged menu.
	const returnedItems = flaggedItems.slice(0, limit);
	const menuIds = [...new Set(returnedItems.map((i) => i.menu_id))];
	const servedBy = new Map<string, EncodedItemLocation[]>();
	if (menuIds.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT id, name, menu_id FROM locations
				 WHERE menu_id IN (SELECT value FROM json_each(?)) ORDER BY name`
			)
			.bind(JSON.stringify(menuIds))
			.all<{ id: string; name: string; menu_id: string }>();
		for (const row of results) {
			const list = servedBy.get(row.menu_id) ?? [];
			list.push({ id: row.id, name: row.name });
			servedBy.set(row.menu_id, list);
		}
	}

	const items: EncodedItem[] = returnedItems.map((item) => {
		const serving = servedBy.get(item.menu_id) ?? [];
		return {
			...item,
			locations: serving.slice(0, ITEM_LOCATION_CAP),
			location_count: serving.length
		};
	});
	const locations = flaggedLocations.slice(0, limit);
	const menus = flaggedMenus.slice(0, limit);
	const brands = flaggedBrands.slice(0, limit);

	const total =
		flaggedItems.length + flaggedLocations.length + flaggedMenus.length + flaggedBrands.length;
	const returned = items.length + locations.length + menus.length + brands.length;
	return {
		items,
		locations,
		menus,
		brands,
		total,
		returned,
		additional: total - returned,
		suppressed_dismissed: filter.suppressed
	};
}
