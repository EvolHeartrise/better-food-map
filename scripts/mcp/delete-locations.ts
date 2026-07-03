// ---------------------------------------------------------------------------
// Batch hard-delete of locations, mirroring the batched update_locations. Kept in
// its own module so it is unit-testable without importing db-mcp-server.ts (which
// opens a stdio transport on import).
//
// Same caveat as the single delete_location: a hard delete cascades a venue's
// sources/overrides/likes and orphans its private menu — PREFER close_location for
// a real venue that has permanently closed (it preserves likes). Reserve this for
// mistaken/duplicate rows.
// ---------------------------------------------------------------------------

import { deleteLocation, type D1Like } from '../../src/lib/server/db';

export interface DeleteLocationsResult {
	/** How many rows were actually removed. */
	deleted: number;
	/** Ids that existed and were deleted. */
	deleted_ids: string[];
	/** Ids that matched no row (already gone / never existed). */
	not_found_ids: string[];
}

/**
 * Deletes each given location id via {@link deleteLocation}, partitioning the ids
 * into those actually removed and those that matched no row. Ids are de-duplicated
 * first so a repeated id can't land in both lists. `deleted` is the count removed.
 */
export async function deleteLocationsBatch(
	db: D1Like,
	ids: string[]
): Promise<DeleteLocationsResult> {
	const deletedIds: string[] = [];
	const notFoundIds: string[] = [];
	for (const id of new Set(ids)) {
		if (await deleteLocation(db, id)) deletedIds.push(id);
		else notFoundIds.push(id);
	}
	return { deleted: deletedIds.length, deleted_ids: deletedIds, not_found_ids: notFoundIds };
}
