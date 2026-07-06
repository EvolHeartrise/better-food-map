/**
 * Resolve a wire-shape location into the fully-resolved form the map page
 * renders. The wire payload sends each menu only once (keyed by menu_id)
 * instead of copying it onto every branch that serves it; this rebuilds the
 * effective menu — the items of the location's menu (its own private menu, or
 * a shared brand menu) with this location's per-item overrides applied (items
 * marked unavailable dropped, overridden prices used) — and attaches the
 * menu's `last_verified` freshness date and its `sources` (provenance is
 * menu-level, shown once for the venue).
 *
 * Generic over the item shape (#83): the viewport/search payloads carry lean
 * MapItems (the map only renders names + tags), while the by-id detail fetch
 * resolves full Items for the open venue's panel.
 *
 * Lives in a pure module (not inline in +page.svelte) so
 * scripts/search-parity.test.ts can feed the client search filter the SAME
 * resolved menus the page builds, rather than a hand-copied mirror.
 */

import type { MapData, MapItem, MapLocation, Source } from './server/db';

/**
 * A location with its FULL effective menu resolved, plus its menu's
 * `last_verified` freshness date (null for unverified/private menus) and its
 * menu-level `sources`. Instantiated with the full `Item` this is the
 * detail-panel shape (VenueDetail.svelte) — only the by-id fetch carries full
 * Items; the in-view set resolves to lean MapItems (#83).
 */
export type ResolvedLocation<I extends MapItem> = MapLocation & {
	menu: I[];
	lastVerified: string | null;
	sources: Source[];
};

export function resolveLocation<I extends MapItem>(
	loc: MapLocation,
	data: MapData<I>
): ResolvedLocation<I> {
	const menu: I[] = [];
	if (loc.menu_id) {
		const overrideByItem = new Map(loc.overrides.map((o) => [o.item_id, o]));
		for (const menuItem of data.menus[loc.menu_id] ?? []) {
			const override = overrideByItem.get(menuItem.id);
			if (override?.available === false) continue; // not served at this branch
			// Reuse the shared item object unless this branch overrides its price.
			// A price override only applies to the full detail shape — the lean
			// viewport items carry no price to override. The cast is sound: the
			// spread copies I and rewrites `price`, which Item types number|null.
			if (override !== undefined && override.price !== null && 'price' in menuItem) {
				menu.push({ ...menuItem, price: override.price } as I);
			} else {
				menu.push(menuItem);
			}
		}
	}
	const meta = loc.menu_id ? data.menuMeta[loc.menu_id] : undefined;
	return {
		...loc,
		menu,
		lastVerified: meta?.last_verified ?? null,
		sources: meta?.sources ?? []
	};
}
