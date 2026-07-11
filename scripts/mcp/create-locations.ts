// ---------------------------------------------------------------------------
// create_locations batch orchestration — the layer BETWEEN the create_locations
// / import_chain MCP tools and the db-write `insertLocations` primitive. It owns
// the id-skip idempotency, per-row invalid collection (all-or-nothing unless
// skip_invalid), OSM-verbatim coordinate/address resolution, coordinate-exact
// dedup (against the map AND within the batch), near-duplicate same-name
// warnings, and location-boundary chunking with partial-failure reporting.
//
// Split out of the large db-mcp-server.ts (which executes a stdio side effect on
// import) into a focused module that takes `db: D1Like` and the OSM store as
// PARAMETERS — so the batch semantics can be unit-tested against the freshDb()
// harness without starting an MCP server. Mirrors scripts/mcp/source-input.ts,
// address-patch.ts and create-chain.ts. Behaviour is preserved verbatim from the
// inline versions these replaced.
// ---------------------------------------------------------------------------

import { type D1Like, type Source } from '../../src/lib/server/db';
import {
	assertBrandMenuRefs,
	existingIds,
	existingLocationsAtCoords,
	existingLocationsByOsmId,
	coordinateKey,
	openLocationsInBbox,
	insertLocations,
	chunkLocationInserts,
	type LocationInsert
} from '../../src/lib/server/db-write';
import type { TagId } from '../../src/lib/tags';
import type { Category } from '../../src/lib/category';
import { normalizePhone } from '../../src/lib/phone';
import { normalizeOpeningHours, weeklyHoursJson } from '../../src/lib/opening-hours';
import { normalizeName, namesMatch } from '../osm/search-poi';
import { bboxAround, haversineMeters } from '../osm/geo';
import { effectivePoiAddressParts } from '../osm/map-feature';
import type { StoredPoi } from '../osm/poi-store';
import { ToolPartialFailure } from './partial-failure';
import { normalizeAddressParts } from './address-patch';
import { assertHasSource, normalizeSources } from './source-input';

/** One inline menu item on a create_locations input (an independent venue's own menu). */
export interface CreateLocationMenuItem {
	item_name: string;
	description?: string | null;
	price?: number | null;
	tags: string[];
	optional_tags?: string[];
	id?: string;
}

/**
 * One create_locations item as the tool accepts it (the shape inferred from the
 * MCP arg schema in db-mcp-server.ts). Kept as a plain interface so this module
 * has no dependency on the valibot schema / MCP wiring.
 */
export interface CreateLocationInput {
	name: string;
	category?: Category | null;
	osm_id?: string;
	latitude?: number;
	longitude?: number;
	street?: string;
	city?: string;
	region?: string;
	postcode?: string | null;
	country?: string | null;
	phone?: string | null;
	website?: string | null;
	/**
	 * Weekly hours in OSM `opening_hours` syntax. With `osm_id`, undefined means
	 * "take the POI's hours" (the streamlined path); an explicit null imports
	 * without hours; a string overrides the POI (e.g. fresher hours from the
	 * venue's own site). Without `osm_id` it is simply stored (or absent).
	 */
	opening_hours?: string | null;
	brand_id?: string | null;
	menu_id?: string | null;
	currency?: string;
	menu_items?: CreateLocationMenuItem[];
	sources?: { url: string; label?: string | null }[];
	closed_reason?: string;
	id?: string;
}

/** One item that failed to resolve in a skip_invalid batch (or a combined error). */
export interface SkippedInvalid {
	name: string;
	osm_id?: string;
	reason: string;
}

/** What {@link createLocationsBatch} returns — the create_locations result shape. */
export interface CreateLocationsResult {
	created: number;
	location_ids: string[];
	items_created: number;
	item_ids: string[];
	skipped_existing_ids: string[];
	skipped_duplicate_locations?: { name: string; existing_id: string | null }[];
	skipped_invalid?: SkippedInvalid[];
	warnings?: string[];
}

/** Coordinates + normalized address + category + hours, ready for insertLocations. */
export interface ResolvedLocationCore {
	latitude: number;
	longitude: number;
	category: Category | null;
	street: string;
	city: string;
	region: string;
	postcode: string | null;
	country: string;
	/** Raw OSM-syntax hours (caller's, else the POI's on an osm_id import), or null. */
	opening_hours: string | null;
}

/** The OSM staging store surface this module needs — just a POI lookup by id. */
export interface OsmStoreLike {
	getByOsmId(osmId: string): StoredPoi | null;
}

/** Two same-name venues within this distance are flagged as likely duplicates. */
export const NEAR_DUPLICATE_M = 150;

/**
 * Statement cap per insertLocations call (one D1 batch = one HTTP request whose
 * body inlines every statement). Bounds the multi-location case; a single
 * location whose inline menu alone exceeds this still ships as one atomic batch
 * (its menu row must precede the location FK), which the cap cannot split.
 */
export const MAX_BATCH_STATEMENTS = 200;

/**
 * Warnings for new points that sit suspiciously close to a SAME-NAME venue —
 * either one already on the map, or another item in this very batch (OSM itself
 * sometimes carries two stale nodes for one venue; coordinate-exact dedup cannot
 * catch those, so they surface here for a human/agent decision instead of
 * silently landing as two pins).
 */
export async function nearDuplicateWarnings(
	db: D1Like,
	toInsert: { it: CreateLocationInput; core: ResolvedLocationCore }[]
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
	const existing = await openLocationsInBbox(db, {
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
						`Verify (e.g. against the chain's own store locator) and delete_locations the duplicate row.`
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
						`delete_locations the duplicate row.`
				);
			}
		}
	});
	return warnings;
}

/**
 * Resolves one create_locations item's raw hours: the caller's value when given
 * (null = "import without hours"), else the staging POI's on an `osm_id` import
 * — the streamlined path that carries OSM hours onto the map without the agent
 * re-typing them. Non-fatal oddities surface through `warn`: a value the
 * normalizer rejects is dropped; one beyond the parsed OSM subset is kept
 * raw-only (displayed verbatim, no machine-readable table).
 */
export function resolveOpeningHoursInput(
	callerHours: string | null | undefined,
	poiHours: string | null,
	warn: (message: string) => void
): string | null {
	const chosen = callerHours === undefined ? poiHours : callerHours;
	if (chosen === null || chosen === undefined) return null;
	const normalized = normalizeOpeningHours(chosen);
	if (normalized === null) {
		warn(`opening_hours ${JSON.stringify(chosen)} dropped — blank, oversized or malformed.`);
		return null;
	}
	if (weeklyHoursJson(normalized) === null) {
		warn(
			`opening_hours "${normalized}" is beyond the parsed OSM subset — stored raw-only ` +
				'(displayed verbatim, not machine-readable).'
		);
	}
	return normalized;
}

/**
 * Resolves one create_locations item's coordinates + address, enforcing the
 * OSM-based coordinate policy. With `osm_id` the coordinates come VERBATIM from the
 * matching staging-store POI; the address defaults to the POI's best available
 * parts — its own addr:* tags, then the enriched address line (containing building
 * / Overture), then the extract-time admin-boundary city/region — with any
 * caller-supplied part overriding. Without `osm_id`, latitude/longitude and
 * street/city/region are required and used as given. Throws an MCP-friendly error on
 * unresolved or conflicting input; non-fatal oddities (a dropped partial postcode)
 * go through `warn`.
 */
export function resolveLocationInsertCore(
	osmStore: OsmStoreLike,
	it: CreateLocationInput,
	warn: (message: string) => void
): ResolvedLocationCore {
	if (it.osm_id) {
		if (it.latitude !== undefined || it.longitude !== undefined) {
			throw new Error(
				`"${it.name}": do not pass latitude/longitude together with osm_id — coordinates are taken ` +
					'verbatim from the OSM POI to guarantee an exact match. Omit them.'
			);
		}
		const poi = osmStore.getByOsmId(it.osm_id);
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
		return {
			latitude: poi.latitude,
			longitude: poi.longitude,
			category: it.category ?? poi.suggested_category ?? null,
			opening_hours: resolveOpeningHoursInput(it.opening_hours, poi.opening_hours, warn),
			...addr
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
		opening_hours: resolveOpeningHoursInput(it.opening_hours, null, warn),
		...normalizeAddressParts(
			{
				street: it.street,
				city: it.city,
				region: it.region,
				postcode: it.postcode,
				country: it.country
			},
			warn
		)
	};
}

/**
 * The create_locations core, shared with import_chain: validates chain refs,
 * skips already-created ids, resolves coordinates/addresses (collecting EVERY
 * failure rather than dying on the first), de-dups by exact coordinates AND by
 * already-stamped osm_id (a moved node's re-import), warns
 * about near-duplicates, and inserts the remainder in bounded chunks — each
 * location atomic with its own private menu/items, cross-location atomicity
 * per chunk (a mid-run failure reports the committed part, see ToolPartialFailure).
 */
export async function createLocationsBatch(
	db: D1Like,
	osmStore: OsmStoreLike,
	items: CreateLocationInput[],
	opts: { skipInvalid?: boolean } = {}
): Promise<CreateLocationsResult> {
	// Validate each DISTINCT brand/menu pair once — a chain backfill reuses a
	// single pair across the whole batch, so this is usually one check.
	const checkedPairs = new Set<string>();
	for (const it of items) {
		const key = `${it.brand_id ?? ''}|${it.menu_id ?? ''}`;
		if (checkedPairs.has(key)) continue;
		checkedPairs.add(key);
		await assertBrandMenuRefs(db, it.brand_id, it.menu_id);
	}
	// Idempotency: skip items whose explicit id already exists, so retrying a batch
	// that already landed is a no-op rather than a primary-key collision.
	const explicitIds = items.map((it) => it.id).filter((id): id is string => Boolean(id));
	const already = explicitIds.length
		? await existingIds(db, 'locations', explicitIds)
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
	const resolved: { it: CreateLocationInput; core: ResolvedLocationCore }[] = [];
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
			// Inline items build the venue's private menu, so its provenance must be cited
			// (sources are menu-level). A born-closed tombstone / a bare location has no menu.
			if (it.menu_items?.length) assertHasSource(it.sources, `"${it.name}"`);
			const warn = (message: string): void => {
				warnings.push(`"${it.name}"${it.osm_id ? ` (${it.osm_id})` : ''}: ${message}`);
			};
			resolved.push({ it, core: resolveLocationInsertCore(osmStore, it, warn) });
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
		db,
		resolved.map(({ core }) => ({
			latitude: core.latitude,
			longitude: core.longitude
		}))
	);
	const skippedDuplicateLocations: {
		name: string;
		existing_id: string | null;
	}[] = [];
	const seenCoords = new Set<string>();
	const afterCoordDedup = resolved.filter(({ it, core }) => {
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
	// Identity de-dup (osm_id, migration 0028): coordinate-exact dedup cannot
	// catch a re-import of a node that MOVED in a fresh extract — same source
	// node, new coordinates. One osm_id must never resolve to two rows, so a
	// candidate whose osm_id is already stamped is skipped like a coordinate
	// duplicate, with a warning: the move itself is worth a look (the stored
	// row's coordinates are now stale). An in-batch repeat of one osm_id never
	// reaches here — the same POI yields identical coordinates, so seenCoords
	// above already dropped it.
	const existingByOsmId = await existingLocationsByOsmId(
		db,
		afterCoordDedup.flatMap(({ it }) => (it.osm_id ? [it.osm_id] : []))
	);
	const toInsert = afterCoordDedup.filter(({ it }) => {
		const onMap = it.osm_id ? existingByOsmId.get(it.osm_id) : undefined;
		if (!onMap) return true;
		skippedDuplicateLocations.push({ name: it.name, existing_id: onMap.id });
		warnings.push(
			`"${it.name}" (${it.osm_id}) is already on the map as ${onMap.id} ("${onMap.name}") with the ` +
				`same osm_id but different coordinates — the OSM node moved since that row was imported. ` +
				`Skipped; verify the venue and update the stored coordinates/address if the move is real.`
		);
		return false;
	});
	warnings.push(...(await nearDuplicateWarnings(db, toInsert)));
	// Pre-assign ids to any inline menu_items so we can return them; a location,
	// its private menu and its items all land in the same atomic batch. Per-insert
	// item ids are kept aside so a partial failure below reports only committed ones.
	const itemIdsByInsert = new Map<LocationInsert, string[]>();
	const inserts = toInsert.map(({ it, core }) => {
		const itemIds: string[] = [];
		const menuItems = (it.menu_items ?? []).map((mi) => {
			const id = mi.id ?? crypto.randomUUID();
			itemIds.push(id);
			return {
				id,
				item_name: mi.item_name,
				description: mi.description ?? null,
				price: mi.price ?? null,
				tags: mi.tags as TagId[],
				optionalTags: mi.optional_tags as TagId[] | undefined
			};
		});
		const insert: LocationInsert = {
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
			// Stored canonical (E.164): OSM/agent phones arrive in every shape; one
			// stored form keeps display uniform and same-phone dedup coordinate-exact.
			// `core.country` is the already-normalized ISO-2 (so bare NANP numbers infer +1).
			phone: normalizePhone(it.phone, core.country),
			website: it.website ?? null,
			// Resolved above (caller's, else the POI's on an osm_id import); the
			// write layer derives the machine-readable opening_hours_json from it.
			opening_hours: core.opening_hours,
			// Durable source identity (migration 0028): an osm_id import stamps the
			// POI's id on the row; a manual-coordinates venue stores NULL.
			osm_id: it.osm_id ?? null,
			brand_id: it.brand_id ?? null,
			menu_id: it.menu_id ?? null,
			currency: it.currency,
			// Provenance is menu-level: the venue's `sources` cite its private menu (built
			// from the inline items above); ignored when there are no items / no menu.
			...(menuItems.length ? { menuSources: normalizeSources(it.sources) as Source[] } : {}),
			// A born-closed tombstone: stamp closed_at now so it's hidden from the map yet
			// still blocks re-creation / search_poi re-suggestion (migration 0015).
			...(it.closed_reason ? { closed_at: Date.now(), closed_reason: it.closed_reason } : {}),
			...(menuItems.length ? { items: menuItems } : {})
		};
		itemIdsByInsert.set(insert, itemIds);
		return insert;
	});
	// One insertLocations call is one D1 batch — every statement inlined into a
	// single HTTP request — and the schema allows 100 locations × 200 inline items,
	// tens of thousands of statements (#89). Chunk at location boundaries so no
	// request grows unbounded; each location stays atomic with its private menu +
	// items, but cross-location atomicity is per CHUNK: a mid-run failure surfaces
	// the committed chunks via ToolPartialFailure instead of losing them.
	const ids: string[] = [];
	const itemIds: string[] = [];
	for (const chunk of chunkLocationInserts(inserts, MAX_BATCH_STATEMENTS)) {
		try {
			ids.push(...(await insertLocations(db, chunk)));
		} catch (err) {
			if (!ids.length) throw err; // nothing committed — plain failure
			const cause = err instanceof Error ? err.message : String(err);
			throw new ToolPartialFailure(
				`create_locations failed after creating ${ids.length} of ${inserts.length} location(s): ` +
					`${cause}. The ${ids.length} created locations are committed — re-run the same call to ` +
					`create the rest (explicit ids and coordinate dedup make the committed rows skip on retry).`,
				{
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
				}
			);
		}
		for (const insert of chunk) itemIds.push(...(itemIdsByInsert.get(insert) ?? []));
	}
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
