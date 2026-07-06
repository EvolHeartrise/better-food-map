// ---------------------------------------------------------------------------
// Batch hard-delete of locations, mirroring the batched update_locations. Kept in
// its own module so it is unit-testable without importing db-mcp-server.ts (which
// opens a stdio transport on import).
//
// A hard delete cascades a venue's
// sources/overrides/likes, and removes its private menu (with its items and
// sources) when no other location references it — shared brand menus are left
// untouched. PREFER close_location for a real venue that has permanently closed
// (it preserves likes). Reserve this for mistaken/duplicate rows.
// ---------------------------------------------------------------------------

import { deleteLocation, type D1Like } from '../../src/lib/server/db';
import { ToolPartialFailure } from './partial-failure';

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
 *
 * Each id is its own delete (2 D1 round trips), so a mid-batch throw leaves the
 * earlier deletes committed. Throwing plainly would discard which ids those were —
 * on retry they'd surface as `not_found_ids`, indistinguishable from never-existed,
 * which matters for the duplicate-audit workflow this tool serves. Instead a throw
 * after the first id raises {@link ToolPartialFailure} carrying the committed
 * split so far plus the failing id; a throw on the very first id commits nothing
 * and rethrows plainly.
 */
export async function deleteLocationsBatch(
	db: D1Like,
	ids: string[]
): Promise<DeleteLocationsResult> {
	const unique = [...new Set(ids)];
	const deletedIds: string[] = [];
	const notFoundIds: string[] = [];
	for (const [i, id] of unique.entries()) {
		try {
			if (await deleteLocation(db, id)) deletedIds.push(id);
			else notFoundIds.push(id);
		} catch (err) {
			if (i === 0) throw err; // nothing processed — plain failure
			const cause = err instanceof Error ? err.message : String(err);
			throw new ToolPartialFailure(
				`delete_locations failed on id "${id}" after processing ${i} of ${unique.length} id(s): ` +
					`${cause}. The ${deletedIds.length} deleted row(s) are committed — re-running with the ` +
					`remaining ids (from "${id}" onward) is safe; already-deleted ids would just report as not found.`,
				{
					deleted: deletedIds.length,
					deleted_ids: deletedIds,
					not_found_ids: notFoundIds,
					failed_id: id
				}
			);
		}
	}
	return { deleted: deletedIds.length, deleted_ids: deletedIds, not_found_ids: notFoundIds };
}
