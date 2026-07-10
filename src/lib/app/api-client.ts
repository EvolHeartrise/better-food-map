// The Capacitor client's fetch wrapper for the /api/v1 JSON API (see
// src/lib/server/api.ts for the server contract). Every app-side data shim
// (data-api / user-api / profile-api / locale-api) goes through here.
//
//   • Requests hit `API_ORIGIN` (compile-time; https://betterfoodmaps.com by
//     default). The WebView origin is capacitor://localhost | https://localhost,
//     so these are cross-origin — the server sends exact-origin CORS for them.
//   • The stored bearer token (token-store) is attached as `Authorization` when
//     present; a signed-out request simply omits it.
//   • The server frames every error as `{ message }` with a real status code;
//     we parse that into a thrown Error (message preserved) so callers `.catch`
//     the same way they did the remote functions.
import { API_ORIGIN } from './platform';
import { ensureLoaded, getToken } from './token-store';

/** An API error carrying the server's `{ message }` and HTTP status. */
export class ApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	// Wait for the persisted token to load once, so even the first request on a
	// cold start carries it (a signed-in user is never mis-seeded as signed-out).
	await ensureLoaded();
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers['content-type'] = 'application/json';

	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	if (!response.ok) {
		// Errors are `{ message }` JSON; fall back to the status text if the body
		// isn't the expected shape (e.g. an edge/proxy error).
		let message = response.statusText;
		try {
			const parsed = (await response.json()) as { message?: unknown };
			if (typeof parsed?.message === 'string') message = parsed.message;
		} catch {
			// Non-JSON error body — keep the status text.
		}
		throw new ApiError(message, response.status);
	}

	// 204 (e.g. no content) has an empty body; everything else is JSON.
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
	return request<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
	return request<T>('POST', path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
	return request<T>('PUT', path, body);
}
