// GET /api/v1/user-location — the app's mirror of the getUserLocation remote
// function. Shares the platform.cf read + guards ($lib/server/user-location).
// Returns `{ lat, lng }` or `null` (edge geo unavailable, e.g. local dev). CORS +
// no-store via the apiCors hook.
import { resolveUserLocation } from '$lib/server/user-location';
import { withApi } from '$lib/server/api';

export const GET = withApi(() => resolveUserLocation());
