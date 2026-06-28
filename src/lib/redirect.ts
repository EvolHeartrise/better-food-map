// Where to send a user after they sign in. Shared by the landing page (which reads
// `?redirectTo` and forwards it to the login route), the login route (which stashes
// it for the round trip) and the OAuth callback (which redirects there). Kept in a
// plain `$lib` module — no server-only imports — so the client landing page and the
// server routes use the exact same validation.

/** Where a signed-in user lands when no specific destination was requested. */
export const DEFAULT_REDIRECT = '/map';

/**
 * Validates an untrusted post-login redirect target, returning it only when it is a
 * safe same-origin path, otherwise {@link DEFAULT_REDIRECT}. This is what prevents an
 * open redirect: the value travels through the URL and a cookie, so anything that
 * isn't a bare local path (a `//host` or `/\host` protocol-relative URL, an absolute
 * `https://…`, or junk) is rejected rather than followed.
 */
export function safeInternalPath(
	value: string | null | undefined,
	fallback: string = DEFAULT_REDIRECT
): string {
	if (!value) return fallback;
	// Must be an absolute path, but not one that browsers read as protocol-relative
	// (`//evil.com`, `/\evil.com`) and so resolve to another origin.
	if (value[0] !== '/' || value[1] === '/' || value[1] === '\\') return fallback;
	// Reject control characters (CR/LF, tab, etc.) defensively — a CRLF would otherwise
	// be a header-splitting attempt once this lands in a `Location` header or cookie.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return fallback;
	}
	return value;
}
