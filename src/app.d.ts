// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
/// <reference types="@cloudflare/workers-types" />
import type { Locale } from '$lib/paraglide/runtime';
import type { ResolvedSession } from '$lib/server/session';

declare global {
	namespace App {
		// interface Error {}
		/**
		 * Per-request auth state. `getSession` is installed by the session hook in
		 * hooks.server.ts: a lazy, per-request-memoized resolver of the session
		 * cookie. The D1 session read happens only on the first call (public paths
		 * that never ask stay auth-free), and every call in the same request shares
		 * that one read. Resolves to null when signed out.
		 */
		interface Locals {
			getSession(): Promise<ResolvedSession | null>;
			/**
			 * The locale resolved for this request by the `localize` hook in
			 * hooks.server.ts (cookie → saved-user → Accept-Language → 'en-US'). It is
			 * also what Paraglide's server `getLocale()` returns for the request and
			 * what fills `<html lang>`. Present on every request.
			 */
			locale: Locale;
		}
		// interface PageData {}
		/**
		 * Cloudflare Workers runtime context. `env.DB` is the D1 binding declared
		 * in wrangler.jsonc; it is present in production and emulated locally by
		 * the Cloudflare adapter during `vite dev`. `GOOGLE_CLIENT_ID` /
		 * `GOOGLE_CLIENT_SECRET` are the Google OAuth credentials, supplied as
		 * Worker secrets in production and via `.dev.vars` in local dev. `ctx` is
		 * the Worker's ExecutionContext, whose `waitUntil` lets the auth hook run
		 * the expired-session purge past the response.
		 */
		interface Platform {
			env: {
				DB: D1Database;
				GOOGLE_CLIENT_ID?: string;
				GOOGLE_CLIENT_SECRET?: string;
			};
			cf?: CfProperties;
			ctx?: ExecutionContext;
			// `caches` (the Workers Cache API, home of the per-cell map cache — see
			// $lib/server/cell-cache) needs no declaration here: the adapter's
			// ambient.d.ts already augments Platform with it.
		}
		interface PageState {
			/**
			 * The id of the location whose detail panel is open, set via shallow
			 * routing (`pushState`/`replaceState`). Absent when viewing the results
			 * list. On a fresh load / shared link the id is read from the URL instead
			 * (see the `reroute` hook), since `page.state` is empty on first render.
			 */
			selected?: string;
		}
		// interface Platform {}
	}
}

export {};
