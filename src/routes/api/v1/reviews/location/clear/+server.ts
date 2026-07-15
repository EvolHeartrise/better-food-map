// POST /api/v1/reviews/location/clear { locationId } — delete the current user's
// review of a location (un-star). Mirrors the clearLocationReview remote command
// ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { LocationTargetSchema, removeReview } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { locationId } = parseOr400(LocationTargetSchema, await readJsonBody(event.request));
	await removeReview('location', locationId);
	return { ok: true };
});
