// The mobile-app OAuth one-time-code logic: minting a code after a browser
// sign-in succeeds, and redeeming it for a real session token. Deliberately
// `$app`-free (it takes a D1Like and reads no request/clock of its own — the
// caller passes `now`) so bun test can exercise the mint/redeem/replay/expiry
// boundaries against the D1Like harness, exactly like session.ts. The thin route
// handlers in src/routes/api/v1/auth/* and the OAuth callback call these.
//
// Raw codes/tokens never touch the database: mint hashes the code before storing
// (only the redirect URL carries the raw code), and redeem hashes the presented
// code before looking it up — the same hash-only invariant sessions hold.
import {
	getUserById,
	insertAppAuthCode,
	redeemAppAuthCode,
	deleteExpiredAppAuthCodes,
	type D1Like,
	type User
} from './db';
import { createUserSession } from './session';
import { generateToken, sha256Hex } from './token';

/**
 * How long a one-time code is redeemable. Short: it exists only for the seconds
 * between the browser callback redirecting to the app and the app POSTing it
 * back. Long enough to survive the OS handing the custom-scheme URL to the app.
 */
export const APP_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The app-generated sign-in `state`: a lowercase-hex string of 128–512 bits
 * (32–128 chars). The app mints it in `signIn()` (crypto.getRandomValues), the
 * login route round-trips it through the app-client cookie, and the callback
 * reflects it on the custom-scheme redirect — so the app can prove a redeemed code
 * belongs to the sign-in IT started (login-CSRF / session-fixation defense). Both
 * routes validate against this strict charset + length cap so a hostile `state`
 * query param can never be reflected into a cookie or a redirect; a non-matching
 * value degrades an app round trip to a plain browser sign-in (no app hand-off).
 */
const APP_STATE_PATTERN = /^[0-9a-f]{32,128}$/;

/** Whether `value` is a well-formed app sign-in state (see {@link APP_STATE_PATTERN}). */
export function isValidAppState(value: string | null | undefined): value is string {
	return typeof value === 'string' && APP_STATE_PATTERN.test(value);
}

/**
 * Mints a one-time code for a just-signed-in user and stores ONLY its SHA-256
 * hash (with a ~5 minute expiry), returning the RAW code for the caller to put in
 * the custom-scheme redirect. Called by the OAuth callback when the app-client
 * marker is present instead of setting the browser session cookie.
 */
export async function createAppAuthCode(db: D1Like, userId: string, now: number): Promise<string> {
	const code = generateToken();
	const codeHash = await sha256Hex(code);
	await insertAppAuthCode(db, codeHash, userId, now, now + APP_CODE_TTL_MS);
	return code;
}

/** A freshly-minted session for the app, plus the user it belongs to — the
 *  `/api/v1/auth/token` response body. */
export interface AppSession {
	token: string;
	/** Session expiry as Unix milliseconds. */
	expiresAt: number;
	user: User;
}

/**
 * Redeems a raw one-time code for a new session: hashes it, consumes the row
 * single-use, checks it hasn't expired, then mints a session exactly like the
 * cookie flow (createUserSession) and returns the token + expiry + user. Returns
 * null when the code is unknown, already redeemed (replay), expired, or its user
 * has vanished — the caller maps every null to one opaque 400 so a client can't
 * distinguish the cases. Opportunistically sweeps other expired codes.
 */
export async function exchangeAppAuthCode(
	db: D1Like,
	rawCode: string,
	now: number
): Promise<AppSession | null> {
	const codeHash = await sha256Hex(rawCode);
	const redeemed = await redeemAppAuthCode(db, codeHash);
	// Best-effort cleanup of other abandoned/expired codes. Done AFTER the atomic
	// redeem above so it can never race the row we're consuming; a failure here
	// must not fail a valid exchange, so it's swallowed.
	await deleteExpiredAppAuthCodes(db, now).catch(() => {});

	// Unknown or already-redeemed (replay): the row was gone.
	if (!redeemed) return null;
	// Present but expired: the row is consumed (correct — an expired code is spent).
	if (now >= redeemed.expiresAt) return null;

	const user = await getUserById(db, redeemed.userId);
	if (!user) return null;

	const { token, session } = await createUserSession(db, user.id);
	return { token, expiresAt: session.expires_at, user };
}
