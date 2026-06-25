// Per-request helpers shared by the remote functions in `*.remote.ts`. Centralises
// access to the request-scoped D1 binding and the authenticated user so each
// remote module doesn't re-implement the same guards.
import { getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
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

/** The signed-in user for this request (set by the auth hook), or null. */
export function currentUser(): User | null {
	return getRequestEvent().locals.user;
}

/** Like {@link currentUser} but throws a 401 when signed out — for guarded mutations. */
export function requireUser(): User {
	const user = currentUser();
	if (!user) error(401, 'You must be signed in to do that.');
	return user;
}
