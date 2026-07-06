// Cross-reference validation for the update_items / update_locations MCP tools.
// Kept in its own module so it is unit-testable without importing
// db-mcp-server.ts (which connects a stdio transport on import).
//
// Two holes this closes:
//   • update_items accepted any `menu_id` move unvalidated — a wrong id silently
//     relocated an item (including a shared chain item) onto another venue's
//     private menu or another brand's shared menu.
//   • update_locations validated brand_id/menu_id only when a patch carried the
//     field, so a single-sided patch ({ id, brand_id: null } on a chain branch,
//     or { id, brand_id: "B" } alone) could leave the row in exactly the shapes
//     assertBrandMenuRefs exists to prevent (a brandless location serving a
//     shared brand menu; a cross-brand brand/menu link).

import {
	assertBrandMenuRefs,
	getItemById,
	getMenuById,
	type D1Like,
	type Location
} from '../../src/lib/server/db';

/** The fields of an update_items patch this validation cares about. */
export interface ItemMovePatch {
	id: string;
	menu_id?: string;
}

/**
 * Validates every menu MOVE in an update_items batch before any write. A move
 * must target an existing menu of the item's own brand: a private venue menu
 * (brand_id NULL) belongs to one location and must never receive another
 * venue's items, and a shared menu of a different brand would silently change
 * the item's owning brand (mirroring {@link assertBrandMenuRefs} for
 * locations). Moves between two menus of the SAME brand (e.g. regional menus)
 * are legitimate and pass. A patch whose item id doesn't exist is skipped —
 * updateItems reports it in `not_found_ids` — and a `menu_id` equal to the
 * item's current menu is a no-op.
 */
export async function assertItemMenuMoves(
	db: D1Like,
	patches: readonly ItemMovePatch[]
): Promise<void> {
	for (const patch of patches) {
		if (patch.menu_id === undefined) continue;
		const item = await getItemById(db, patch.id);
		if (!item) continue; // updateItems reports it in not_found_ids
		if (item.menu_id === patch.menu_id) continue; // no-op, not a move
		const target = await getMenuById(db, patch.menu_id);
		if (!target) {
			throw new Error(
				`Item patch "${patch.id}": no menu with id "${patch.menu_id}" — ` +
					`cannot move the item to a nonexistent menu.`
			);
		}
		if (target.brand_id === null) {
			throw new Error(
				`Item patch "${patch.id}": menu "${patch.menu_id}" is another venue's PRIVATE menu — ` +
					`moving the item there would put it on that venue's own menu. Add the dish to that ` +
					`venue with create_items (location_id) instead.`
			);
		}
		const source = await getMenuById(db, item.menu_id);
		const sourceBrandId = source?.brand_id ?? null;
		if (sourceBrandId !== target.brand_id) {
			throw new Error(
				`Item patch "${patch.id}": moving the item from ` +
					(sourceBrandId
						? `brand "${sourceBrandId}"'s menu "${item.menu_id}"`
						: `a venue's private menu "${item.menu_id}"`) +
					` to menu "${patch.menu_id}" would change its owning brand to "${target.brand_id}". ` +
					`Items only move between menus of the same brand — create the item on the other ` +
					`brand's menu with create_items instead.`
			);
		}
	}
}

/** The fields of an update_locations patch this validation cares about. */
export interface LocationRefPatch {
	id: string;
	brand_id?: string | null;
	menu_id?: string | null;
}

/**
 * Validates the brand/menu references of every update_locations patch before
 * any write. A patch carrying BOTH fields is validated as-is (each distinct
 * pair once per batch). A patch carrying only ONE of them is merged with the
 * stored row and the EFFECTIVE post-patch pair is validated — a field a patch
 * omits does not go away, so `{ brand_id: null }` on a chain branch or
 * `{ brand_id: "B" }` alone must not slip past {@link assertBrandMenuRefs}. A
 * brand detach that would leave the stored shared menu attached is rejected
 * outright (prefer an explicit `menu_id: null` over silent auto-nulling).
 * `getStored` supplies the stored row (memoized by the caller, which also needs
 * it for country scoping); a missing row is skipped — updateLocations reports
 * it in `not_found_ids`.
 */
export async function assertLocationRefPatches(
	db: D1Like,
	patches: readonly LocationRefPatch[],
	getStored: (id: string) => Promise<Location | null>
): Promise<void> {
	const checkedPairs = new Set<string>();
	for (const patch of patches) {
		if (patch.brand_id === undefined && patch.menu_id === undefined) continue;
		if (patch.brand_id !== undefined && patch.menu_id !== undefined) {
			// Full pair supplied — the effective pair IS the patch; validate each
			// distinct pair once (a chain backfill repeats the same pair per branch).
			const key = `${patch.brand_id ?? ''}|${patch.menu_id ?? ''}`;
			if (checkedPairs.has(key)) continue;
			checkedPairs.add(key);
			await assertBrandMenuRefs(db, patch.brand_id, patch.menu_id);
			continue;
		}
		const stored = await getStored(patch.id);
		if (!stored) continue; // updateLocations reports it in not_found_ids
		const effectiveBrand = patch.brand_id !== undefined ? patch.brand_id : stored.brand_id;
		const effectiveMenu = patch.menu_id !== undefined ? patch.menu_id : stored.menu_id;
		// The patch changes nothing (e.g. brand_id: null on an already-independent
		// venue): the stored shape is by construction valid; don't re-judge it —
		// an independent venue's (null, private-menu) pair is stored-legal but
		// would fail the attach-time assertion below.
		if (effectiveBrand === stored.brand_id && effectiveMenu === stored.menu_id) continue;
		if (patch.brand_id === null && stored.brand_id !== null && effectiveMenu !== null) {
			throw new Error(
				`Patch for location "${patch.id}": brand_id: null would detach the brand but leave ` +
					`the location serving brand "${stored.brand_id}"'s shared menu "${effectiveMenu}". ` +
					`Pass menu_id: null alongside to fully detach the branch (or set both fields to ` +
					`the new brand/menu pair).`
			);
		}
		try {
			await assertBrandMenuRefs(db, effectiveBrand, effectiveMenu);
		} catch (e) {
			throw new Error(
				`Patch for location "${patch.id}": ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}
}
