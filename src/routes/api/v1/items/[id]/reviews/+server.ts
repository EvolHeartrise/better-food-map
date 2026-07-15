// GET /api/v1/items/[id]/reviews?cursor= — a page of a menu item's public reviews
// plus the viewer's own review. Mirrors the getItemReviews remote function via the
// shared schema + read ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { ItemReviewsQuerySchema, readReviews } from '$lib/server/reviews';
import { parseOr400, withApi } from '$lib/server/api';

export const GET = withApi((event) => {
	const { itemId, cursor } = parseOr400(ItemReviewsQuerySchema, {
		itemId: event.params.id,
		cursor: event.url.searchParams.get('cursor') ?? undefined
	});
	return readReviews('item', itemId, cursor);
});
