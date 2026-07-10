// Pure CORS + response-header helpers for the /api/v1 mobile API. Deliberately
// dependency-free (Web `Request`/`Response`/`Headers` only — no `@sveltejs/kit`,
// no `$app`, no message catalog) so the auth hook can import it AND bun test can
// exercise the allow-list/echo/preflight logic directly. The framework-bound
// pieces (JSON error wrapping, valibot parse helpers) live in ./api on top of
// this. See ./api's header for why /api/v1 exists at all.

/** Path prefix identifying the mobile JSON API (used by the `apiCors` hook). */
export const API_V1_PREFIX = '/api/v1';

/**
 * Exact-match CORS allowlist for the app's WebView origins:
 *   • `capacitor://localhost` — iOS (Capacitor serves the app from this origin)
 *   • `https://localhost`     — Android (Capacitor's https scheme)
 *   • `http://localhost:5050` — local `vite dev` (the repo's dev port)
 * No wildcard: an Origin is echoed back ONLY on exact match. Requests with NO
 * Origin header (native fetch plugins, not subject to the browser CORS gate) are
 * unaffected — CORS response headers are additive, never a gate for them.
 */
export const API_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
	'capacitor://localhost',
	'https://localhost',
	'http://localhost:5050'
]);

const ALLOW_METHODS = 'GET, POST, PUT, OPTIONS';
const ALLOW_HEADERS = 'authorization, content-type';
const MAX_AGE_SECONDS = '86400'; // 24h — how long a browser may cache the preflight

/** The request's Origin if it is on the allowlist, else null. */
function allowedOrigin(request: Request): string | null {
	const origin = request.headers.get('origin');
	return origin && API_ALLOWED_ORIGINS.has(origin) ? origin : null;
}

/**
 * Stamps CORS + `no-store` onto a real /api/v1 response (called by the hook for
 * every non-OPTIONS response). `Vary: Origin` is ALWAYS set (the body varies by
 * whether the Origin was allow-listed, so a shared cache must key on it);
 * `Access-Control-Allow-Origin` is set only when the Origin matches the allowlist.
 */
export function applyApiResponseHeaders(request: Request, response: Response): void {
	response.headers.set('Cache-Control', 'no-store');
	response.headers.append('Vary', 'Origin');
	const origin = allowedOrigin(request);
	if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
}

/**
 * The CORS preflight response (204) for an OPTIONS request to /api/v1 — the
 * allowed methods/headers and the max-age, plus the echoed Origin only on an
 * allow-list match. A disallowed (or absent) Origin gets no
 * `Access-Control-Allow-Origin`, so the browser blocks the real request; native
 * no-Origin clients don't preflight, so this never affects them.
 */
export function apiPreflightResponse(request: Request): Response {
	const headers = new Headers({
		'Cache-Control': 'no-store',
		Vary: 'Origin',
		'Access-Control-Allow-Methods': ALLOW_METHODS,
		'Access-Control-Allow-Headers': ALLOW_HEADERS,
		'Access-Control-Max-Age': MAX_AGE_SECONDS
	});
	const origin = allowedOrigin(request);
	if (origin) headers.set('Access-Control-Allow-Origin', origin);
	return new Response(null, { status: 204, headers });
}
