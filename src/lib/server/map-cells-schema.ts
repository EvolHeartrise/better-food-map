// The map-cells request SCHEMA, kept in its own `$app`-free module (valibot +
// $lib/grid only — no cell-cache/$app import) so bun test can exercise the
// validation directly, and both the getMapCells remote function and the GET
// /api/v1/map-cells endpoint share this ONE schema. The handler that consumes a
// validated request lives in ./map-cells-query (which does reach the cache layer).
import * as v from 'valibot';
import {
	FULL_LEVEL_MAX_CELLS,
	MAX_GRID_LEVEL,
	MIN_REP_LEVEL,
	REP_LEVEL_MAX_CELLS,
	levelCell
} from '$lib/grid';

/**
 * A batch of same-level grid cells the map page asks for (see $lib/grid for the
 * level/cell model; the page enumerates the cells covering its viewport and
 * sends only the ones its client store is missing), with the ACTIVE SEARCH
 * riding along: `q` is the combined free-text term and `diet` the dietary-tag
 * selector, both narrowing what each cell returns (see SearchFilter in
 * $lib/server/db) — so searching stays cell-based and panning under a search
 * fetches matches for the newly visible cells. Validated because this is
 * an open endpoint (remote function AND /api/v1): `level` must be a level a real
 * client can produce (level 0, or a representative rung at/above the ~440 m
 * floor — anything else would spray the server cache with junk keys), the cell
 * count is capped per level (rep batches are bounded by the coarsening invariant;
 * full-detail batches by narrow-viewport geometry, so a forged request can't fan
 * a full-menu read across hundreds of cells), each index must lie inside the
 * lat/lng data domain, and the filter lengths bound what reaches the FTS index
 * (200 far exceeds any real search term). `diet` is only length-capped here;
 * the handler collapses anything outside the six-id dietary vocabulary to null
 * via `sanitizeDiet` ($lib/diet-profile) — matching what the client renders for
 * no selection — so a forged value can't mint junk colo-cache keys per block or
 * force guaranteed-empty D1 reads (the cache design assumes the documented
 * 6-value diet cardinality).
 */
const CellIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
export const MapCellsQuerySchema = v.pipe(
	v.object({
		level: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_GRID_LEVEL)),
		cells: v.pipe(
			v.array(v.tuple([CellIndexSchema, CellIndexSchema])),
			v.minLength(1),
			v.maxLength(REP_LEVEL_MAX_CELLS)
		),
		q: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
		diet: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64))), null)
	}),
	v.check((q) => q.level === 0 || q.level >= MIN_REP_LEVEL, 'Unknown grid level'),
	v.check(
		(q) => q.level !== 0 || q.cells.length <= FULL_LEVEL_MAX_CELLS,
		'Too many full-detail cells'
	),
	v.check((q) => {
		const cell = levelCell(q.level);
		const maxI = Math.floor(180 / cell);
		const maxJ = Math.floor(360 / cell);
		return q.cells.every(([i, j]) => i <= maxI && j <= maxJ);
	}, 'Cell outside the coordinate domain')
);

/** The validated input shape (post-parse) both consumers hand to `runMapCellsQuery`. */
export type MapCellsQueryInput = v.InferOutput<typeof MapCellsQuerySchema>;
