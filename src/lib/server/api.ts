// ---------------------------------------------------------------------------
// /api/v1 — the mobile app's JSON API. Shared framework glue (this module) + the
// thin route handlers under src/routes/api/v1 are the ROOT of that surface. The
// pure CORS/preflight helpers live in ./api-cors (imported by the hook and the
// tests); this module adds the `@sveltejs/kit`- and catalog-bound pieces.
//
// DELIBERATE EXCEPTION to the "remote functions over API routes" convention in
// CLAUDE.md — the same class of exception as the sitemap routes. The consumers
// here are non-browser mobile clients (Capacitor WebView + native fetch plugins)
// that cannot speak SvelteKit's remote-function wire protocol, so they need plain
// HTTP+JSON endpoints. Every endpoint is a THIN wrapper that calls the SAME
// shared implementation the matching remote function calls (getMapCells →
// $lib/server/map-cells-query, likes → $lib/server/likes, diet →
// $lib/server/diet, …) — the validation and DB logic live in one place; only the
// HTTP framing lives here.
//
// CORS + no-store + the OPTIONS preflight are applied centrally by the `apiCors`
// hook (hooks.server.ts) so they cover successes, thrown errors and 404s alike;
// this module provides the JSON error wrapper (reusing SvelteKit's error()
// semantics and the remote functions' existing m.* keys) and small parse helpers
// so no route re-implements validation.
// ---------------------------------------------------------------------------
import * as v from 'valibot';
import { error, isHttpError, json, type RequestEvent } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { m } from '$lib/paraglide/messages';
import { requireUser } from './context';
import { apiBodyTooLarge } from './api-cors';
import type { User } from './db';

// Re-exported so route handlers have one import site for the API helpers.
export {
	API_V1_PREFIX,
	apiAllowedOrigins,
	applyApiResponseHeaders,
	apiPreflightResponse
} from './api-cors';

/**
 * A short, ENGLISH, dev-facing message for a malformed API request (a bad query
 * string or JSON body). Not a user-facing UI string — a conforming app never hits
 * it — so it stays out of the message catalog, exactly like the valibot `v.check`
 * messages and the other internal/dev errors CLAUDE.md keeps in English.
 */
export const INVALID_REQUEST_MESSAGE = 'Invalid request.';

/**
 * A short, ENGLISH, dev-facing message for an over-sized request body (413). Like
 * {@link INVALID_REQUEST_MESSAGE} a conforming app never hits it, so it stays out
 * of the message catalog.
 */
export const PAYLOAD_TOO_LARGE_MESSAGE = 'Request body too large.';

/** A handler that returns a JSON-serializable value (wrapped in a JSON Response by
 *  {@link withApi}) or an already-built Response (passed through); may be async. */
type ApiHandler = (event: RequestEvent) => unknown;

/**
 * Wraps an /api/v1 handler so its result becomes a JSON response and EVERY error
 * path is a JSON `{ message }` body with the right status — regardless of the
 * client's Accept header (SvelteKit's default endpoint error rendering is
 * Accept-dependent, which a native client can't be trusted to set). A thrown
 * SvelteKit `error(status, msg)` (from requireUser's 401, the FK-violation 400, a
 * validation 400, …) maps to `{ message: msg }` with that status — reusing the
 * remote functions' existing m.* keys verbatim. Any other thrown error is logged
 * and returned as a generic 500. CORS + no-store are added afterwards by the hook.
 */
export function withApi(handler: ApiHandler): (event: RequestEvent) => Promise<Response> {
	return async (event) => {
		try {
			const result = await handler(event);
			return result instanceof Response ? result : json(result);
		} catch (e) {
			if (isHttpError(e)) return json({ message: e.body.message }, { status: e.status });
			// An unexpected fault (not a deliberate error()): log it and return a
			// generic 500 rather than leaking internals. m.error_generic is an existing
			// catalog key ("Something went wrong").
			console.error('Unhandled /api/v1 error', e);
			return json({ message: m.error_generic() }, { status: 500 });
		}
	};
}

/**
 * Validates `input` against `schema`, throwing a 400 (JSON-ified by {@link withApi})
 * on failure so no route re-implements the reject path. Used for both parsed query
 * strings and JSON bodies — the schema is the SAME one the remote function uses,
 * so validation is never copy-pasted, only the transport differs.
 */
export function parseOr400<TSchema extends v.GenericSchema>(
	schema: TSchema,
	input: unknown
): v.InferOutput<TSchema> {
	const result = v.safeParse(schema, input);
	if (!result.success) error(400, INVALID_REQUEST_MESSAGE);
	return result.output;
}

/**
 * Reads and JSON-parses a request body, throwing a 413 for an over-sized body
 * (before parsing — Content-Length first, then a defensive check on the read text
 * in case it is missing/under-reported) and a 400 on invalid JSON.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
	if (apiBodyTooLarge(request.headers.get('content-length'))) {
		error(413, PAYLOAD_TOO_LARGE_MESSAGE);
	}
	let text: string;
	try {
		text = await request.text();
	} catch {
		error(400, INVALID_REQUEST_MESSAGE);
	}
	if (apiBodyTooLarge(null, text)) error(413, PAYLOAD_TOO_LARGE_MESSAGE);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		error(400, INVALID_REQUEST_MESSAGE);
	}
}

/**
 * Like {@link requireUser} (the shared 401-when-signed-out guard) but ALSO rejects
 * a session resolved from a browser COOKIE: every MUTATING /api/v1 route must be
 * driven by the app's `Authorization: Bearer` token, never an ambient same-site
 * cookie. This is defense-in-depth against login-CSRF on top of SameSite=Lax + the
 * CORS preflight — structural rather than incidental. A cookie-resolved session
 * gets the SAME opaque 401 as a signed-out request. GET endpoints don't use this
 * (a cookie-driven read is harmless and useful for debugging); auth/token is
 * unauthenticated and auth/signout reads the bearer token from the header directly,
 * so both are already cookie-immune.
 */
export async function requireBearerUser(): Promise<User> {
	const user = await requireUser();
	if (getRequestEvent().locals.sessionSource !== 'bearer') {
		error(401, m.server_error_sign_in_required());
	}
	return user;
}
