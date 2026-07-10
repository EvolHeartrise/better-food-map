// Token/session logic: generation, hashing, validation and the sliding refresh.
// Deliberately free of `$app/*` imports (the cookie helpers live in auth.ts) so
// bun test can exercise the expiry/refresh boundaries against the D1Like harness
// — mirroring the sitemap.ts (testable) / sitemap-cache.ts (app-bound) split.
// The session ROW lives in D1 via the db.ts helpers; the caller's cookie holds
// an opaque token whose SHA-256 hash is the row's primary key, so the raw token
// never touches the database.
import {
	createSession,
	deleteSession,
	getSessionWithUser,
	updateSessionExpiry,
	type D1Like,
	type Session,
	type User
} from './db';
import { generateToken, sha256Hex } from './token';

/** How long a session lives from its last use. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Slide the expiry forward only once a session is past the first half of its life,
 * so a steadily-active user's session never expires but we don't write to D1 (or
 * re-set the cookie) on every single request.
 */
const SESSION_REFRESH_AFTER_MS = SESSION_TTL_MS / 2;

/**
 * A fresh, high-entropy session token (256 bits, hex). Stored only in the cookie
 * (browser) or handed to the app as a bearer token; its SHA-256 is the row key.
 * Thin alias over the shared {@link generateToken} so token/hash minting has one
 * home (see token.ts) — the app one-time code uses the same primitive.
 */
export function generateSessionToken(): string {
	return generateToken();
}

/**
 * Extracts the raw token from an `Authorization: Bearer <token>` header, or
 * undefined when the header is absent or not a Bearer credential. The scheme is
 * matched case-insensitively (per RFC 7235 the scheme is case-insensitive); the
 * token itself is returned verbatim (it is an opaque hex string). Pure and
 * `$app`-free so the auth hook and the sign-out endpoint share ONE parser and
 * bun test can exercise it directly. The mobile app cannot use cookies, so this
 * bearer path is how a native client presents its session (see hooks.server.ts).
 */
export function parseBearerToken(header: string | null | undefined): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
	return match ? match[1] : undefined;
}

/**
 * How a request's session was resolved by the auth hook: the mobile app's
 * `Authorization: Bearer` token, or a browser session cookie. Recorded on
 * `event.locals.sessionSource` so mutating /api/v1 routes can require the bearer
 * path (see requireBearerUser in $lib/server/api).
 */
export type SessionSource = 'bearer' | 'cookie';

/**
 * Classifies a request by its `Authorization` header: `'bearer'` when it carries a
 * Bearer credential (the app), else `'cookie'` (the browser cookie path, whether
 * or not a cookie is actually present). Pure and `$app`-free so the auth hook and
 * bun test share ONE classifier.
 */
export function sessionSourceFor(authHeader: string | null | undefined): SessionSource {
	return parseBearerToken(authHeader) ? 'bearer' : 'cookie';
}

/** Creates a new session for a user and returns the token to put in the cookie. */
export async function createUserSession(
	db: D1Like,
	userId: string
): Promise<{ token: string; session: Session }> {
	const token = generateSessionToken();
	const sessionId = await sha256Hex(token);
	const now = Date.now();
	const session = await createSession(db, sessionId, userId, now + SESSION_TTL_MS, now);
	return { token, session };
}

/** Outcome of validating a session token from a cookie. */
export interface SessionValidation {
	session: Session;
	user: User;
	/**
	 * The user's saved UI locale (migration 0024), or null when unsaved. Folded in
	 * by getSessionWithUser so the request-path locale resolution reads it here.
	 * Raw as stored (typed `string | null`); the caller validates it with isLocale.
	 */
	locale: string | null;
	/** True if the expiry was just slid forward, so the caller should re-set the cookie. */
	refreshed: boolean;
}

/**
 * Validates a cookie token: looks up its hashed session, drops it if expired, and
 * slides its expiry forward when past the refresh threshold. Returns null when the
 * token matches no live session.
 */
export async function validateSessionToken(
	db: D1Like,
	token: string
): Promise<SessionValidation | null> {
	const sessionId = await sha256Hex(token);
	const found = await getSessionWithUser(db, sessionId);
	if (!found) return null;

	const now = Date.now();
	if (now >= found.session.expires_at) {
		await deleteSession(db, sessionId);
		return null;
	}

	let refreshed = false;
	if (now >= found.session.expires_at - SESSION_REFRESH_AFTER_MS) {
		const expiresAt = now + SESSION_TTL_MS;
		await updateSessionExpiry(db, sessionId, expiresAt);
		found.session.expires_at = expiresAt;
		refreshed = true;
	}

	return { session: found.session, user: found.user, locale: found.locale, refreshed };
}

/** Invalidates the session behind a cookie token (sign-out). */
export async function invalidateSessionToken(db: D1Like, token: string): Promise<void> {
	await deleteSession(db, await sha256Hex(token));
}

/** The signed-in user + session behind a request's cookie, or null when signed out. */
export interface ResolvedSession {
	session: Session;
	user: User;
	/**
	 * The user's saved UI locale (migration 0024), or null when unsaved — folded
	 * into the session lookup so resolveLocale (hooks.server.ts) can read it from
	 * this one memoized read. Raw as stored; validate with isLocale before use.
	 */
	locale: string | null;
}

/**
 * Cookie side effects the lazy resolver needs, injected by the auth hook so this
 * module stays `$app`-free (the hook binds them to SvelteKit's `event.cookies`).
 */
export interface SessionCookieSink {
	/** Re-set the session cookie after a sliding refresh moved the expiry. */
	setCookie(token: string, expiresAt: number): void;
	/** Clear the session cookie because its token matched no live session. */
	clearCookie(): void;
}

/**
 * Builds the lazy, memoized session resolver the auth hook installs as
 * `event.locals.getSession`. The D1 read (`validateSessionToken`) — plus the
 * expiry-slide UPDATE and the cookie refresh/clear that hang off its result —
 * runs only when some consumer first asks who is signed in, and exactly once
 * per request thereafter (concurrent callers share the same in-flight promise).
 * Public DATA paths — the map-cell/stats remote functions and the cached
 * browse/sitemap routes — never call it, so a signed-in user's cell fetches
 * still don't pay a serial D1 round trip (or a Workers subrequest) for auth
 * they don't use. (The locale hook resolves it once on a top-level document
 * navigation for a signed-in user, to read their saved locale — but skips
 * remote/data requests and pins the cached crawl routes to English; see
 * resolveLocale in hooks.server.ts.)
 *
 * The memo lives in this closure — created per request by the hook — never in
 * module scope: a module-level memo would leak one request's D1 promise into
 * the next (see the memo/waitUntil notes in $lib/server/memo.ts).
 */
export function createLazySessionResolver(
	db: D1Like | undefined,
	token: string | undefined,
	cookies: SessionCookieSink
): () => Promise<ResolvedSession | null> {
	let memo: Promise<ResolvedSession | null> | undefined;

	async function resolve(): Promise<ResolvedSession | null> {
		if (!token || !db) return null;
		const result = await validateSessionToken(db, token);
		if (!result) {
			// Invalid or expired token: same as the old eager hook, drop the cookie.
			cookies.clearCookie();
			return null;
		}
		// A sliding refresh moved the row's expiry; keep the cookie's in step.
		if (result.refreshed) cookies.setCookie(token, result.session.expires_at);
		return { session: result.session, user: result.user, locale: result.locale };
	}

	return () => (memo ??= resolve());
}
