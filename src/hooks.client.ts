import { defineCustomClientStrategy, isLocale } from '$lib/paraglide/runtime';

// Client half of the `custom-appLocale` strategy (its server half lives in
// hooks.server.ts). The server resolves the request locale and renders it into
// `<html lang>`; the client reads that same attribute back, so client and server
// always agree on the locale with zero extra state — no cookie, no
// `navigator.languages` re-negotiation that could disagree with the server's
// Accept-Language decision, and therefore no hydration flicker.
//
// In Phase 1 nothing renders a message on the client yet, so this is a rail for
// later phases rather than something with a visible effect today.
defineCustomClientStrategy('custom-appLocale', {
	getLocale: () => {
		const lang = document.documentElement.lang;
		// Guard: fall through to the next strategy (baseLocale) rather than throw
		// if the attribute is ever missing/unexpected.
		return isLocale(lang) ? lang : undefined;
	},
	// No locale switcher exists in Phase 1, so this is never called. Phase 4 wires
	// persistence here (write the LOCALE_COOKIE from hooks.server.ts, then reload).
	// Keeping the DOM attribute in step is a harmless, correct minimum for now.
	setLocale: (locale) => {
		document.documentElement.lang = locale;
	}
});
