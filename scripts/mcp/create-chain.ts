// ---------------------------------------------------------------------------
// create_chain bundle: create a brand, one regional menu under it, and that
// menu's shared items in ONE call (mirroring how create_locations accepts inline
// menu_items). Cuts the create_brand → create_menu → create_items round-trips of
// the documented chain-bootstrap flow down to a single tool call.
//
// Split out of the large db-mcp-server.ts into a focused, directly
// unit-testable module.
//
// Semantics preserved from the individual tools:
//   • id-idempotency — an explicit brand/menu id that ALREADY exists is a no-op,
//     reported in `already_existed` (matching create_brand / create_menu), so a
//     retry with the ids a partial failure returned is safe;
//   • same-name warnings — a brand name that collides (findBrandIdsByName) or a
//     menu name that collides under the brand (findMenuIdsByName) is flagged, not
//     blocked, exactly as the single tools flag them.
//
// Atomicity: brand → menu → items has FK ordering, and the insert helpers each
// run their own D1 round trip, so this cannot be one atomic batch with the
// existing helpers. It instead runs them in sequence and, on a mid-sequence
// failure, throws ToolPartialFailure carrying what was already committed
// (brand_id, then menu_id) — the same pattern create_locations / import_chain use
// — so a retry passing those ids back is an idempotent no-op that resumes.
// ---------------------------------------------------------------------------

import {
	getBrandById,
	getMenuById,
	findBrandIdsByName,
	findMenuIdsByName,
	insertBrand,
	insertMenu,
	insertMenuItems,
	type D1Like,
	type MenuItemInsert,
	type Source
} from '../../src/lib/server/db';
import { ToolPartialFailure } from './partial-failure';

/** One item to add to the chain's shared menu (menu_id is supplied by the bundle). */
export type ChainItemInput = Omit<MenuItemInsert, 'menu_id'>;

export interface CreateChainInput {
	brand: { name: string; website?: string | null; logo_url?: string | null; id?: string };
	menu: {
		name: string;
		region?: string | null;
		currency?: string;
		refresh_notes?: string | null;
		sources?: Source[];
		id?: string;
	};
	/** The menu's shared items; may be empty to scaffold just the brand + menu. */
	items: ChainItemInput[];
}

export interface CreateChainResult {
	brand_id: string;
	menu_id: string;
	item_ids: string[];
	created_items: number;
	/** Present only when an explicit brand/menu id already existed (that half was a no-op). */
	already_existed?: { brand: boolean; menu: boolean };
	warnings?: string[];
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Creates a brand, its regional menu and the menu's items in FK order. Returns the
 * ids of all three plus `already_existed` (per-half) and same-name `warnings`.
 * Throws {@link ToolPartialFailure} carrying the committed ids if a later stage
 * fails, so the caller can retry with those ids as a safe no-op.
 */
export async function createChainBundle(
	db: D1Like,
	input: CreateChainInput
): Promise<CreateChainResult> {
	const warnings: string[] = [];

	// --- Brand (idempotent on an explicit id; same-name is flagged, not blocked) ---
	let brandId: string;
	let brandExisted = false;
	if (input.brand.id && (await getBrandById(db, input.brand.id))) {
		brandId = input.brand.id;
		brandExisted = true;
	} else {
		const dupIds = await findBrandIdsByName(db, input.brand.name);
		if (dupIds.length) {
			warnings.push(
				`A brand named "${input.brand.name}" already exists (id ${dupIds.join(', ')}). Created a new ` +
					`brand anyway — if this is the same chain, reuse the existing brand instead.`
			);
		}
		brandId = await insertBrand(db, {
			id: input.brand.id,
			name: input.brand.name,
			website: input.brand.website ?? null,
			logo_url: input.brand.logo_url ?? null
		});
	}

	// --- Menu (under the brand just resolved). A failure here has already committed
	//     the brand, so report it so a retry with brand.id resumes without duplicating. ---
	let menuId: string;
	let menuExisted = false;
	try {
		if (input.menu.id && (await getMenuById(db, input.menu.id))) {
			menuId = input.menu.id;
			menuExisted = true;
		} else {
			const dupIds = await findMenuIdsByName(db, brandId, input.menu.name);
			if (dupIds.length) {
				warnings.push(
					`A menu named "${input.menu.name}" already exists under this brand (id ${dupIds.join(', ')}). ` +
						`Created a new menu anyway — reuse the existing one if this is a duplicate.`
				);
			}
			menuId = await insertMenu(db, {
				id: input.menu.id,
				brand_id: brandId,
				name: input.menu.name,
				region: input.menu.region ?? null,
				currency: input.menu.currency,
				refresh_notes: input.menu.refresh_notes ?? null,
				sources: input.menu.sources
			});
		}
	} catch (err) {
		throw new ToolPartialFailure(
			`create_chain created the brand (${brandId}) but failed creating its menu: ${messageOf(err)}. ` +
				`The brand is committed — re-run the same call passing brand.id "${brandId}" (a no-op) to continue.`,
			{ brand_id: brandId }
		);
	}

	// --- Items on the menu (skipped entirely for a scaffold-only bundle). Both the
	//     brand and menu are committed by now, so a failure reports both ids. ---
	let itemIds: string[] = [];
	if (input.items.length) {
		try {
			itemIds = await insertMenuItems(
				db,
				input.items.map((it) => ({ ...it, menu_id: menuId }))
			);
		} catch (err) {
			throw new ToolPartialFailure(
				`create_chain created the brand (${brandId}) and menu (${menuId}) but failed creating its ` +
					`items: ${messageOf(err)}. Both are committed — re-run passing brand.id "${brandId}" and ` +
					`menu.id "${menuId}" (both no-ops) to add the items.`,
				{ brand_id: brandId, menu_id: menuId }
			);
		}
	}

	return {
		brand_id: brandId,
		menu_id: menuId,
		item_ids: itemIds,
		created_items: itemIds.length,
		...(brandExisted || menuExisted
			? { already_existed: { brand: brandExisted, menu: menuExisted } }
			: {}),
		...(warnings.length ? { warnings } : {})
	};
}
