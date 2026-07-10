// PUT /api/v1/me/locale { locale } — saves the current user's UI locale (the
// cross-device copy), mirroring the setLocale remote function's D1 write. The
// cookie half of setLocale is skipped: it is meaningless for the cookieless app,
// which sends its locale on each request itself. Validated to a supported locale
// via the SAME `v.picklist(locales)` setLocale uses. 401 when signed out (there is
// nothing to save for an anonymous request). CORS + no-store via the apiCors hook.
import * as v from 'valibot';
import { requireUser, requireDb } from '$lib/server/context';
import { setUserLocale } from '$lib/server/db';
import { locales } from '$lib/paraglide/runtime';
import { parseOr400, readJsonBody, withApi } from '$lib/server/api';

const LocaleBodySchema = v.object({ locale: v.picklist(locales) });

export const PUT = withApi(async (event) => {
	const { locale } = parseOr400(LocaleBodySchema, await readJsonBody(event.request));
	const user = await requireUser();
	await setUserLocale(requireDb(), user.id, locale, Date.now());
	return { locale };
});
