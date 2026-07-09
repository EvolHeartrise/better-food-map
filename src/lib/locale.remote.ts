import * as v from 'valibot';
import { command, getRequestEvent } from '$app/server';
import { requireDb, currentUser } from '$lib/server/context';
import { setUserLocale } from '$lib/server/db';
import { setLocaleCookie } from '$lib/server/locale-cookie';
import { locales, type Locale } from '$lib/paraglide/runtime';

/**
 * Persists an explicit language pick from the selector. Two writes:
 *  1. the consent-exempt preference cookie — this browser's explicit choice,
 *     honored first by resolveLocale (hooks.server.ts) on every later request;
 *  2. D1 (user_locale), but only when signed in, so the choice follows the user
 *     across devices.
 *
 * MUST be a `command`, not a `query`: it sets a cookie, and SvelteKit forbids
 * `query` remote functions from writing cookies (see the note in hooks.server.ts
 * `authenticate`). `command`/`form` reach the request event's cookies.
 *
 * The argument is validated to a supported locale (e.g. `'en-US' | 'fr'`) before either
 * write, so nothing unsupported is ever stored — the source-of-truth for the
 * allowlist is Paraglide's `locales`. The caller reloads the page afterwards so
 * the SSR-rendered strings and `<html lang>` re-render together in the new locale
 * (a client-only swap would desync them).
 */
export const setLocale = command(v.picklist(locales), async (locale: Locale) => {
	const { cookies } = getRequestEvent();
	setLocaleCookie(cookies, locale);
	const user = await currentUser();
	if (user) await setUserLocale(requireDb(), user.id, locale, Date.now());
});
