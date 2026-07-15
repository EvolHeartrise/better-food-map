// POST /api/v1/reviews/location/report { reviewId, reason? } — report a public
// location review; auto-hides past the threshold. Mirrors the reportLocationReview
// remote command ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { ReportSchema, report } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { reviewId, reason } = parseOr400(ReportSchema, await readJsonBody(event.request));
	return report('location', reviewId, reason);
});
