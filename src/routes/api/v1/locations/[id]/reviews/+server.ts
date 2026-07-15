// GET /api/v1/locations/[id]/reviews?cursor= — a page of a location's public reviews
// plus the viewer's own review. Mirrors the getLocationReviews remote function via
// the shared schema + read ($lib/server/reviews). A cookie-driven read is harmless
// here (public data + own review), so no requireBearerUser. CORS + no-store via the
// apiCors hook.
import { LocationReviewsQuerySchema, readReviews } from '$lib/server/reviews';
import { parseOr400, withApi } from '$lib/server/api';

export const GET = withApi((event) => {
	const { locationId, cursor } = parseOr400(LocationReviewsQuerySchema, {
		locationId: event.params.id,
		cursor: event.url.searchParams.get('cursor') ?? undefined
	});
	return readReviews('location', locationId, cursor);
});
