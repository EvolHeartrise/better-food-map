// POST /api/v1/reviews/item/report { reviewId, reason? } — report a public item
// review; auto-hides past the threshold. Mirrors the reportItemReview remote command
// ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { ReportSchema, report } from '$lib/server/reviews';
import { parseOr400, readJsonBody, requireBearerUser, withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	await requireBearerUser();
	const { reviewId, reason } = parseOr400(ReportSchema, await readJsonBody(event.request));
	return report('item', reviewId, reason);
});
