// POST /api/v1/bookmarks/item { itemId, on } — bookmark/un-bookmark a menu item for
// the current user. Mirrors the setItemBookmarked remote command via the shared
// schema + write ($lib/server/bookmarks). CORS + no-store via the apiCors hook.
import { ItemBookmarkSchema, bookmark } from '$lib/server/bookmarks';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { itemId, on } = parseOr400(ItemBookmarkSchema, await readJsonBody(event.request));
	await bookmark('item', itemId, on);
	return { ok: true };
});
