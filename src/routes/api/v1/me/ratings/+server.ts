// GET /api/v1/me/ratings — the current user's own rating per location/item (empty
// when signed out). Mirrors the getMyRatings remote function via the shared
// readViewerRatings() ($lib/server/reviews). CORS + no-store via the apiCors hook.
import { readViewerRatings } from '$lib/server/reviews';
import { withApi } from '$lib/server/api';

export const GET = withApi(() => readViewerRatings());
