// GET /api/v1/me/bookmarks — the current user's bookmarked location + item ids
// (empty lists when signed out). Mirrors the getBookmarks remote function via the
// shared readBookmarksForCurrentUser() ($lib/server/bookmarks). CORS + no-store via
// the apiCors hook.
import { readBookmarksForCurrentUser } from '$lib/server/bookmarks';
import { withApi } from '$lib/server/api';

export const GET = withApi(() => readBookmarksForCurrentUser());
