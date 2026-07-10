// GET /api/v1/locations/[id] — the app's mirror of the getLocationData remote
// function. Shares the schema + handler ($lib/server/location-data). Returns the
// same {@link MapData} shape; an unknown id and a closed venue both yield an EMPTY
// payload (`locations: []`), exactly as getLocationData does — the client treats
// an empty locations array as "not found". CORS + no-store via the apiCors hook.
import { getLocationDataSchema, getLocationDataById } from '$lib/server/location-data';
import { parseOr400, withApi } from '$lib/server/api';

export const GET = withApi((event) => {
	const id = parseOr400(getLocationDataSchema, event.params.id);
	return getLocationDataById(id);
});
