// Opaque-token primitives shared by every secret the app mints and stores as a
// HASH rather than in the clear: the session token (session.ts) and the app
// one-time auth code (app-auth.ts). Deliberately `$app`-free and dependency-free
// (Web Crypto only, available in the Worker) so bun test can exercise the
// hash/generation directly against the D1Like harness — the same split reason
// session.ts is kept `$app`-free.
//
// The invariant both callers rely on: a raw token/code lives only in transit (a
// cookie, a bearer header, a redirect URL); what lands in D1 is its SHA-256, so a
// database leak can never be replayed as a live session or a redeemable code.

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** SHA-256 of a string, hex-encoded (Web Crypto — available in the Worker). */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return toHex(new Uint8Array(digest));
}

/** A fresh, high-entropy opaque token (256 bits, hex). Kept only in transit; its
 *  SHA-256 is what's persisted. Used for both session tokens and app auth codes. */
export function generateToken(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
