import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// SvelteKit config lives here (not in svelte.config.js). Since @sveltejs/kit 2.62
// you can pass the kit/compiler config straight to the `sveltekit()` plugin, and
// when you do, any svelte.config.js is ignored. The `kit` options (adapter,
// experimental.remoteFunctions) sit at the top level of the plugin options.
export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			// Builds for Cloudflare Workers (Static Assets). The adapter also
			// emulates platform bindings (e.g. the D1 `DB` binding from
			// wrangler.jsonc) during `vite dev`.
			adapter: adapter(),
			experimental: {
				// Enable SvelteKit remote functions (.remote.ts files).
				remoteFunctions: true
			},
			compilerOptions: {
				runes: true,
				experimental: {
					// Allow top-level `await` in components (needed to await remote queries in markup).
					async: true
				}
			}
		}),
		// Paraglide (inlang) i18n. Compiles project.inlang + messages/*.json into
		// tree-shakable message functions under `outdir` on dev/build. Placed AFTER
		// sveltekit() to match the current official inlang SvelteKit example.
		//
		// `strategy` is the ordered locale-resolution chain the generated runtime
		// uses. We do NOT list any built-in that could WRITE a cookie or trigger a
		// URL redirect (no `url`, no bare `cookie` write path): locale is resolved
		// read-only. `custom-appLocale` is registered on the server in
		// src/hooks.server.ts (cookie stub -> saved-user stub -> Accept-Language,
		// q-weighted) and on the client in src/hooks.client.ts (reads the server-
		// rendered <html lang>, so client and server always agree — no cookie, no
		// hydration flicker). `baseLocale` ('en') is the final fallback.
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['custom-appLocale', 'baseLocale']
		})
	],
	server: {
		// Dev server port. The Google OAuth callback is derived from this origin
		// (http://localhost:5050/auth/callback/google in dev), so keep it in step
		// with the redirect URI registered in the Google console (see .dev.vars).
		port: 5050
	}
});
