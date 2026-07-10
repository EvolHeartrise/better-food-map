// POST /api/v1/likes/location { locationId, liked } — like/unlike a location for
// the current user. Mirrors the setLocationLiked remote command via the shared
// schema + write ($lib/server/likes), including the FK-violation→400 mapping and
// the 401-when-signed-out guard. CORS + no-store via the apiCors hook.
import { LocationLikeSchema, likeLocation } from '$lib/server/likes';
import { parseOr400, readJsonBody, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	const { locationId, liked } = parseOr400(LocationLikeSchema, await readJsonBody(event.request));
	await likeLocation(locationId, liked);
	return { ok: true };
});
