// GET /api/v1/map-cells?level=&cells=&q=&diet= — the mobile app's mirror of the
// getMapCells remote function. Shares the schema + handler verbatim
// ($lib/server/map-cells-query); only the query-string decoding is here. See
// $lib/server/api for why /api/v1 exists as an exception to the remote-function
// convention. CORS + no-store are applied by the apiCors hook.
import { MapCellsQuerySchema, runMapCellsQuery } from '$lib/server/map-cells-query';
import { parseOr400, withApi } from '$lib/server/api';

export const GET = withApi((event) => {
	const params = event.url.searchParams;
	// `cells` is a flat comma-separated list of integers read as (i, j) PAIRS — the
	// grid cell indices (see $lib/grid). An odd count or a non-integer token leaves a
	// malformed tuple that the shared schema rejects as a 400, so no extra guard is
	// needed here.
	const nums = (params.get('cells') ?? '')
		.split(',')
		.filter((s) => s !== '')
		.map(Number);
	const cells: [number, number][] = [];
	for (let i = 0; i < nums.length; i += 2) cells.push([nums[i], nums[i + 1]]);

	const validated = parseOr400(MapCellsQuerySchema, {
		level: Number(params.get('level')),
		cells,
		q: params.get('q') ?? '',
		// Absent → null (no diet); present → the raw value, collapsed to a known id by
		// the shared handler's sanitizeDiet.
		diet: params.get('diet')
	});
	return runMapCellsQuery(validated);
});
