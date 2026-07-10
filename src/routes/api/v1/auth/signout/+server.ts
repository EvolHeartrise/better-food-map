// POST /api/v1/auth/signout — invalidates the caller's session row. Bearer-
// authenticated: the token to revoke is the one in the Authorization header (the
// app has no cookie). Idempotent — invalidating an already-gone token is a no-op
// — so it always returns { ok: true } once a bearer token is present; a request
// with no bearer token is a 401. CORS + no-store via the apiCors hook.
import { error } from '@sveltejs/kit';
import { requireDb } from '$lib/server/context';
import { invalidateSessionToken, parseBearerToken } from '$lib/server/auth';
import { m } from '$lib/paraglide/messages';
import { withApi } from '$lib/server/api';

export const POST = withApi(async (event) => {
	const token = parseBearerToken(event.request.headers.get('authorization'));
	if (!token) error(401, m.server_error_sign_in_required());
	await invalidateSessionToken(requireDb(), token);
	return { ok: true };
});
