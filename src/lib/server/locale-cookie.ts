// The explicit locale-preference cookie: name + writer. Kept next to auth.ts's
// session-cookie glue and shaped the same way (host-locked name in prod, dropped
// under `vite dev`; Secure dropped in dev). Split into its own module — rather
// than living inline in hooks.server.ts — so the setLocale command (which WRITES
// it) and the localize hook (which READS it) share one name and attribute set.
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { hostCookieName } from './cookie-name';

/**
 * Name of the explicit locale-preference cookie: `__Host-locale` in production
 * (host-locked against subdomain cookie-tossing, exactly like SESSION_COOKIE —
 * see cookie-name.ts), plain `locale` under `vite dev`. Phase 1 read this
 * (read-only stub); Phase 4 writes it — and ONLY when a user actively picks a
 * language. Accept-Language auto-detection never sets it.
 */
export const LOCALE_COOKIE = hostCookieName('locale', dev);

// ~1 year. A UI-customization cookie remembering an explicit choice; long-lived so
// the preference survives across visits without re-detecting from Accept-Language.
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Sets the locale-preference cookie: Path=/, SameSite=Lax, HttpOnly, ~1y maxAge,
 * Secure in production (dropped under `vite dev` so it still sets over plain-HTTP
 * `http://localhost` — mirroring setSessionCookie). HttpOnly is deliberate: the
 * cookie is set AND read server-side; the picker learns the current locale from
 * getLocale() / <html lang>, never by reading this cookie in JS.
 *
 * This is a consent-EXEMPT ePrivacy "UI customization" cookie: it stores only an
 * explicit choice the user actively made in the language selector, so it needs no
 * consent banner. It is therefore written ONLY on an active pick (the setLocale
 * command), never on Accept-Language auto-detection.
 */
export function setLocaleCookie(cookies: Cookies, locale: string): void {
	cookies.set(LOCALE_COOKIE, locale, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: LOCALE_COOKIE_MAX_AGE
	});
}
