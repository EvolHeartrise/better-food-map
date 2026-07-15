// POST /api/v1/reviews/item/clear { itemId } — delete the current user's review of a
// menu item (un-star). Mirrors the clearItemReview remote command
// ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { ItemTargetSchema, removeReview } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { itemId } = parseOr400(ItemTargetSchema, await readJsonBody(event.request));
	await removeReview('item', itemId);
	return { ok: true };
});
