import {
	baseLocale,
	defineCustomClientStrategy,
	extractLocaleFromNavigator,
	getTextDirection,
	isLocale
} from '$lib/paraglide/runtime';
import { IS_APP } from '$lib/app/platform';

// Client half of the `custom-appLocale` strategy (its server half lives in
// hooks.server.ts). Two shapes, by build target:
if (IS_APP) {
	// APP: there is no server to stamp <html lang> per request — the static shell
	// carries a single build-time locale (baseLocale) — so we resolve the locale
	// from the DEVICE. `extractLocaleFromNavigator` matches navigator.languages
	// against the supported set (full tag first, then language-prefix), and we
	// fall back to baseLocale. The result is applied to <html lang>/<dir> up front
	// (fixing the shell's build-time value) and returned by the strategy so every
	// message renders in it. There is no in-app locale switcher — the UI language
	// tracks the device setting.
	const resolveAppLocale = () => {
		const detected = extractLocaleFromNavigator();
		return detected && isLocale(detected) ? detected : baseLocale;
	};
	const applyLocale = (locale: string) => {
		document.documentElement.lang = locale;
		document.documentElement.dir = getTextDirection(locale);
	};

	applyLocale(resolveAppLocale());

	defineCustomClientStrategy('custom-appLocale', {
		getLocale: () => resolveAppLocale(),
		setLocale: (locale) => applyLocale(locale)
	});
} else {
	// WEB: the server resolves the request locale and renders it into <html lang>;
	// the client reads that same attribute back, so client and server always agree
	// with zero extra state — no cookie, no navigator re-negotiation, no hydration
	// flicker.
	defineCustomClientStrategy('custom-appLocale', {
		getLocale: () => {
			const lang = document.documentElement.lang;
			// Guard: fall through to the next strategy (baseLocale) rather than throw
			// if the attribute is ever missing/unexpected.
			return isLocale(lang) ? lang : undefined;
		},
		// Keeping the DOM attribute in step is a harmless, correct minimum: an
		// explicit locale switch reloads the page, so the server re-renders it.
		setLocale: (locale) => {
			document.documentElement.lang = locale;
		}
	});
}
