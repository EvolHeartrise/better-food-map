// Pure CORS + response-header helpers for the /api/v1 mobile API. Deliberately
// dependency-free (Web `Request`/`Response`/`Headers` only — no `@sveltejs/kit`,
// no `$app`, no message catalog) so the auth hook can import it AND bun test can
// exercise the allow-list/echo/preflight logic directly. The framework-bound
// pieces (JSON error wrapping, valibot parse helpers) live in ./api on top of
// this. See ./api's header for why /api/v1 exists at all.

/** Path prefix identifying the mobile JSON API (used by the `apiCors` hook). */
export const API_V1_PREFIX = '/api/v1';

/**
 * The app's PRODUCTION WebView origins, exact-match CORS allowlist:
 *   • `capacitor://localhost` — iOS (Capacitor serves the app from this origin)
 *   • `https://localhost`     — Android (Capacitor's https scheme)
 * No wildcard: an Origin is echoed back ONLY on exact match. Requests with NO
 * Origin header (native fetch plugins, not subject to the browser CORS gate) are
 * unaffected — CORS response headers are additive, never a gate for them.
 */
export const API_PROD_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
	'capacitor://localhost',
	'https://localhost'
]);

/**
 * The local `vite dev` origin (the repo's dev port). Allowed ONLY in dev so it
 * never ships in the production CORS allowlist — see {@link apiAllowedOrigins}.
 */
export const API_DEV_ORIGIN = 'http://localhost:5050';

/**
 * The effective CORS allowlist for a build: the production WebView origins, plus
 * the local dev origin when `dev` is true. `dev` is passed in (rather than
 * importing `$app/environment`) so this module stays `$app`-free and bun test can
 * exercise both branches directly; the hook wires it from `$app/environment`.
 */
export function apiAllowedOrigins(dev: boolean): ReadonlySet<string> {
	return dev ? new Set([...API_PROD_ALLOWED_ORIGINS, API_DEV_ORIGIN]) : API_PROD_ALLOWED_ORIGINS;
}

/**
 * Upper bound on an /api/v1 JSON request body (16 KiB) — far above any real
 * payload (the largest is a 256-char one-time code), so it only rejects hostile
 * over-sized bodies before they are parsed. See {@link apiBodyTooLarge}.
 */
export const MAX_API_BODY_BYTES = 16 * 1024;

/**
 * True when a request body exceeds {@link MAX_API_BODY_BYTES}. Pure so bun test
 * can exercise it: pass the `Content-Length` header (checked before reading the
 * body — a lie of a garbage/absent value is simply ignored, `Number('')`/`null`
 * → 0, `NaN` → not-finite) and/or the already-read body text (a defensive check
 * for a missing or under-reported Content-Length).
 */
export function apiBodyTooLarge(contentLength: string | null, bodyText?: string): boolean {
	const declared = Number(contentLength);
	if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) return true;
	return bodyText !== undefined && bodyText.length > MAX_API_BODY_BYTES;
}

const ALLOW_METHODS = 'GET, POST, PUT, OPTIONS';
const ALLOW_HEADERS = 'authorization, content-type';
const MAX_AGE_SECONDS = '86400'; // 24h — how long a browser may cache the preflight

/** The request's Origin if it is on the given allowlist, else null. */
function allowedOrigin(request: Request, allowed: ReadonlySet<string>): string | null {
	const origin = request.headers.get('origin');
	return origin && allowed.has(origin) ? origin : null;
}

/**
 * Stamps CORS + `no-store` onto a real /api/v1 response (called by the hook for
 * every non-OPTIONS response). `Vary: Origin` is ALWAYS set (the body varies by
 * whether the Origin was allow-listed, so a shared cache must key on it);
 * `Access-Control-Allow-Origin` is set only when the Origin matches the allowlist.
 */
export function applyApiResponseHeaders(
	request: Request,
	response: Response,
	allowed: ReadonlySet<string>
): void {
	response.headers.set('Cache-Control', 'no-store');
	response.headers.append('Vary', 'Origin');
	const origin = allowedOrigin(request, allowed);
	if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
}

/**
 * The CORS preflight response (204) for an OPTIONS request to /api/v1 — the
 * allowed methods/headers and the max-age, plus the echoed Origin only on an
 * allow-list match. A disallowed (or absent) Origin gets no
 * `Access-Control-Allow-Origin`, so the browser blocks the real request; native
 * no-Origin clients don't preflight, so this never affects them.
 */
export function apiPreflightResponse(request: Request, allowed: ReadonlySet<string>): Response {
	const headers = new Headers({
		'Cache-Control': 'no-store',
		Vary: 'Origin',
		'Access-Control-Allow-Methods': ALLOW_METHODS,
		'Access-Control-Allow-Headers': ALLOW_HEADERS,
		'Access-Control-Max-Age': MAX_AGE_SECONDS
	});
	const origin = allowedOrigin(request, allowed);
	if (origin) headers.set('Access-Control-Allow-Origin', origin);
	return new Response(null, { status: 204, headers });
}
