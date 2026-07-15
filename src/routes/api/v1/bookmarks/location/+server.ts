// POST /api/v1/bookmarks/location { locationId, on } — bookmark/un-bookmark a
// location for the current user. Mirrors the setLocationBookmarked remote command
// via the shared schema + write ($lib/server/bookmarks), including the
// FK-violation→400 mapping and the 401-when-signed-out guard. CORS + no-store via
// the apiCors hook.
import { LocationBookmarkSchema, bookmark } from '$lib/server/bookmarks';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	// Mutations must be driven by the app's bearer token, never an ambient cookie.
	await requireBearerUser();
	const { locationId, on } = parseOr400(LocationBookmarkSchema, await readJsonBody(event.request));
	await bookmark('location', locationId, on);
	return { ok: true };
});
