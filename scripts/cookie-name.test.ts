// Guards the prod/dev auth-cookie naming (src/lib/server/cookie-name.ts): in
// production every auth cookie must carry the `__Host-` prefix (host-locked —
// no subdomain cookie tossing / session fixation), while under `vite dev` the
// prefix must be dropped, because dev serves plain-HTTP localhost without
// `Secure` and browsers reject a non-Secure `__Host-` cookie.
import { expect, test } from 'bun:test';
import { hostCookieName } from '../src/lib/server/cookie-name';

test('production names carry the __Host- prefix', () => {
	expect(hostCookieName('session', false)).toBe('__Host-session');
	expect(hostCookieName('google_oauth_state', false)).toBe('__Host-google_oauth_state');
	expect(hostCookieName('google_code_verifier', false)).toBe('__Host-google_code_verifier');
	expect(hostCookieName('oauth_redirect', false)).toBe('__Host-oauth_redirect');
});

test('dev keeps the bare name (Secure is dropped on http://localhost)', () => {
	expect(hostCookieName('session', true)).toBe('session');
	expect(hostCookieName('oauth_redirect', true)).toBe('oauth_redirect');
});
