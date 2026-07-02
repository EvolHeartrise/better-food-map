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

/** How long a session lives from its last use. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Slide the expiry forward only once a session is past the first half of its life,
 * so a steadily-active user's session never expires but we don't write to D1 (or
 * re-set the cookie) on every single request.
 */
const SESSION_REFRESH_AFTER_MS = SESSION_TTL_MS / 2;

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** SHA-256 of a string, hex-encoded (Web Crypto — available in the Worker). */
async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return toHex(new Uint8Array(digest));
}

/** A fresh, high-entropy session token (256 bits, hex). Stored only in the cookie. */
export function generateSessionToken(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(32)));
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

	return { session: found.session, user: found.user, refreshed };
}

/** Invalidates the session behind a cookie token (sign-out). */
export async function invalidateSessionToken(db: D1Like, token: string): Promise<void> {
	await deleteSession(db, await sha256Hex(token));
}
