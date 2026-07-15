// POST /api/v1/reviews/location { locationId, rating, body? } — upsert the current
// user's rating (+ optional text) for a location. Mirrors the setLocationReview
// remote command via the shared schema + write ($lib/server/reviews). CORS +
// no-store via the apiCors hook.
import { LocationReviewSchema, saveReview } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { locationId, rating, body } = parseOr400(
		LocationReviewSchema,
		await readJsonBody(event.request)
	);
	await saveReview('location', locationId, rating, body);
	return { ok: true };
});
