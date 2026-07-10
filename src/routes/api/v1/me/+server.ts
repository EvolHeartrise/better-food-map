// GET /api/v1/me — `{ user: User | null }` for the current request (the bearer
// session, or null when signed out). Mirrors the getCurrentUser remote function
// via the shared currentUser() helper. CORS + no-store via the apiCors hook.
import { currentUser } from '$lib/server/context';
import { withApi } from '$lib/server/api';

export const GET = withApi(async () => ({ user: await currentUser() }));
