// GET /api/v1/stats — the app's mirror of the getStats remote function. Shares
// the 5-minute memo ($lib/server/stats) so both hit one warmed cache. CORS +
// no-store via the apiCors hook.
import { getCachedStats } from '$lib/server/stats';
import { withApi } from '$lib/server/api';

export const GET = withApi(() => getCachedStats());
