// POST /api/v1/reviews/item { itemId, rating, body? } — upsert the current user's
// rating (+ optional text) for a menu item. Mirrors the setItemReview remote command
// via the shared schema + write ($lib/server/reviews). CORS + no-store via the
// apiCors hook.
import { ItemReviewSchema, saveReview } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { itemId, rating, body } = parseOr400(ItemReviewSchema, await readJsonBody(event.request));
	await saveReview('item', itemId, rating, body);
	return { ok: true };
});
