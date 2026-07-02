// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
/// <reference types="@cloudflare/workers-types" />
import type { Session, User } from '$lib/server/db';

declare global {
	namespace App {
		// interface Error {}
		/**
		 * Per-request auth state, populated by the session hook in hooks.server.ts
		 * from the session cookie. Both are null when signed out.
		 */
		interface Locals {
			user: User | null;
			session: Session | null;
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
