// Per-request helpers shared by the remote functions in `*.remote.ts`. Centralises
// access to the request-scoped D1 binding and the authenticated user so each
// remote module doesn't re-implement the same guards.
import { getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import type { D1Like, User } from './db';

/**
 * The request-scoped D1 binding (`platform.env.DB`, configured in wrangler.jsonc
 * and emulated by the Cloudflare adapter during `vite dev`). Throws a clear error
 * if it is missing rather than failing deep inside a query.
 */
export function requireDb(): D1Like {
	const { platform } = getRequestEvent();
	const binding = platform?.env?.DB;
	if (!binding) {
		throw new Error(
			'D1 binding "DB" is not available on platform.env. Check the d1_databases block in ' +
				'wrangler.jsonc and run the app through the Cloudflare adapter (vite dev / wrangler dev).'
		);
	}
	return binding;
}

/**
 * The signed-in user for this request, or null. Resolved lazily via the hook's
 * memoized `locals.getSession()`: the first caller in a request pays the one D1
 * session read (plus any cookie refresh/clear), later callers share its result,
 * and requests where nothing asks pay nothing.
 */
export async function currentUser(): Promise<User | null> {
	const resolved = await getRequestEvent().locals.getSession();
	return resolved?.user ?? null;
}

/** Like {@link currentUser} but throws a 401 when signed out — for guarded mutations. */
export async function requireUser(): Promise<User> {
	const user = await currentUser();
	if (!user) error(401, m.server_error_sign_in_required());
	return user;
}

/**
 * The signed-in user, but ONLY if they are a review moderator — else a 403. The
 * allowlist is the comma-separated `ADMIN_USER_IDS` env var (a Worker secret in
 * prod, `.dev.vars` locally); unset or absent means nobody is an admin, so every
 * moderation action is refused. Gates the hide/un-hide review commands and the
 * /admin/reviews route.
 */
export async function requireAdmin(): Promise<User> {
	const user = await requireUser();
	const raw = getRequestEvent().platform?.env?.ADMIN_USER_IDS ?? '';
	const admins = raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	// Dev-facing: a regular user never reaches a moderation action, so this stays an
	// English literal (out of the message catalog, like the other internal errors).
	if (!admins.includes(user.id)) error(403, 'Forbidden: not a review moderator.');
	return user;
}
