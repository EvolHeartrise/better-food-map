// The map-cells HANDLER, factored out of data.remote.ts so the `getMapCells`
// remote function AND the GET /api/v1/map-cells endpoint share one handler body.
// The SCHEMA it validates against lives in ./map-cells-schema (kept `$app`-free
// for testing); this module reaches the cache layer, so it must NOT be imported
// by tests (same constraint as cell-cache.ts).
import { getMapCellsCached } from './cell-cache';
import { type MapCellsData } from './db';
import { type MapCellsQueryInput } from './map-cells-schema';
import { searchableQuery } from '$lib/search';
import { sanitizeDiet } from '$lib/diet-profile';

// Re-export the schema so callers have one import site for both halves.
export { MapCellsQuerySchema, type MapCellsQueryInput } from './map-cells-schema';

/**
 * Runs a validated map-cells request: gates the free text through the trigram
 * index's searchable floor ($lib/search) and collapses `diet` to a known dietary
 * id (or null), so only a real filter reaches the (filter, cell)-keyed colo cache
 * — a short/unsearchable query or a junk diet degrades to the plain browse read,
 * exactly what the client itself renders. Then serves it through the same
 * getMapCellsCached path the map uses. This is the whole body of the getMapCells
 * remote function, shared verbatim with the endpoint.
 */
export function runMapCellsQuery({
	level,
	cells,
	q,
	diet
}: MapCellsQueryInput): Promise<MapCellsData> {
	const text = searchableQuery(q);
	// Collapse anything outside the six known diet ids to null (plain browse),
	// like the searchable gate above: only a forged request can send junk here,
	// and it must degrade rather than key the shared colo cache with it.
	const dietTagId = sanitizeDiet(diet);
	const search = text !== '' || dietTagId !== null ? { query: text, dietTagId } : null;
	return getMapCellsCached(level, cells, search);
}
