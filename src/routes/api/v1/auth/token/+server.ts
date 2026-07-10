// POST /api/v1/auth/token { code } — exchanges a one-time app auth code (handed to
// the app by the OAuth callback's custom-scheme redirect) for a real session
// token. The single-use redemption + session minting live in $lib/server/app-auth
// (exchangeAppAuthCode); this route is the thin HTTP framing. On success returns
// { token, expiresAt, user }; every failure (unknown / already-redeemed / expired
// code, or a vanished user) is one opaque 400 so a client can't distinguish them.
// Public (no session yet). CORS + no-store via the apiCors hook.
import { error } from '@sveltejs/kit';
import { requireDb } from '$lib/server/context';
import { exchangeAppAuthCode } from '$lib/server/app-auth';
import { m } from '$lib/paraglide/messages';
import * as v from 'valibot';
import { parseOr400, readJsonBody, withApi } from '$lib/server/api';

// The code is a 64-hex-char opaque token; the cap only rejects hostile payloads.
const TokenBodySchema = v.object({ code: v.pipe(v.string(), v.maxLength(256)) });

export const POST = withApi(async (event) => {
	const { code } = parseOr400(TokenBodySchema, await readJsonBody(event.request));
	const session = await exchangeAppAuthCode(requireDb(), code, Date.now());
	// Reuse the OAuth code-validation message (the one-time code IS an auth code).
	if (!session) error(400, m.server_error_oauth_code_validation());
	return session;
});
