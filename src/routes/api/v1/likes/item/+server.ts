// POST /api/v1/likes/item { itemId, liked } — like/unlike a menu item for the
// current user. Mirrors the setItemLiked remote command via the shared schema +
// write ($lib/server/likes), including the FK-violation→400 mapping and the
// 401-when-signed-out guard. CORS + no-store via the apiCors hook.
import { ItemLikeSchema, likeItem } from '$lib/server/likes';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	// Mutations must be driven by the app's bearer token, never an ambient cookie.
	await requireBearerUser();
	const { itemId, liked } = parseOr400(ItemLikeSchema, await readJsonBody(event.request));
	await likeItem(itemId, liked);
	return { ok: true };
});
