// GET /api/v1/me/likes — the current user's liked location + item ids (empty
// lists when signed out). Mirrors the getLikes remote function via the shared
// readLikesForCurrentUser() ($lib/server/likes). CORS + no-store via the apiCors hook.
import { readLikesForCurrentUser } from '$lib/server/likes';
import { withApi } from '$lib/server/api';

export const GET = withApi(() => readLikesForCurrentUser());
