import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterStatic from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// ---------------------------------------------------------------------------
// Dual build: the default WEB build (Cloudflare Workers, unchanged) and the
// Capacitor mobile-app build, selected by `APP_TARGET=capacitor`
// (`bun run build:app`). The two share ONE codebase; the app build differs only
// in the switches below, and the web build must stay behaviorally identical —
// so every app-only branch here is gated on `IS_APP` and applied nowhere else.
// ---------------------------------------------------------------------------
const IS_APP = process.env.APP_TARGET === 'capacitor';

// Origin the app's JSON API is served from. Defaults to production; override to
// a local server (e.g. http://localhost:5050) with API_ORIGIN for dev builds.
const API_ORIGIN = process.env.API_ORIGIN ?? 'https://betterfoodmaps.com';

const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// In the app build, the four `*.remote.ts` modules can't run (no server), so
// every import of them is redirected to a `$lib/app/**` fetch shim that speaks
// /api/v1 instead. This is done with an `enforce: 'pre'` resolveId plugin rather
// than `kit.alias`: SvelteKit prepends the `$lib` alias, which would shadow any
// `$lib/data.remote` alias placed after it — a `pre` resolver runs first and is
// unambiguous. The plugin is ONLY added in the app build, so the web build
// resolves the real remote modules exactly as before.
const REMOTE_SHIMS: Record<string, string> = {
	'$lib/data.remote': abs('./src/lib/app/data-api.ts'),
	'$lib/user.remote': abs('./src/lib/app/user-api.ts'),
	'$lib/profile.remote': abs('./src/lib/app/profile-api.ts'),
	'$lib/locale.remote': abs('./src/lib/app/locale-api.ts')
};

function appRemoteShims(): Plugin {
	return {
		name: 'bfm-app-remote-shims',
		enforce: 'pre',
		resolveId(id) {
			return REMOTE_SHIMS[id] ?? null;
		}
	};
}

export default defineConfig({
	// Compile-time constants read by src/lib/app/platform.ts. Literals, so an
	// `if (IS_APP)` / `{#if IS_APP}` branch tree-shakes out of the build where it
	// is false, and no `@capacitor/*` code reaches the web bundle.
	define: {
		__IS_APP__: JSON.stringify(IS_APP),
		__API_ORIGIN__: JSON.stringify(API_ORIGIN)
	},
	plugins: [
		...(IS_APP ? [appRemoteShims()] : []),
		sveltekit({
			preprocess: vitePreprocess(),
			// WEB: Cloudflare Workers (Static Assets), with the adapter emulating the
			// D1 `DB` binding under `vite dev`. APP: a client-only SPA — adapter-static
			// in fallback mode, output to build-app/ (Capacitor's webDir), with no
			// server. `strict: false` because the app has no prerenderable pages (the
			// whole tree is `ssr = false` / `prerender = false`); the fallback shell is
			// the only output and adapter-static's all-prerendered check doesn't apply.
			adapter: IS_APP
				? adapterStatic({
						fallback: 'index.html',
						pages: 'build-app',
						assets: 'build-app',
						strict: false
					})
				: adapterCloudflare(),
			// APP: point SvelteKit at the minimal SPA route tree (only +layout/+page/
			// +error thin wrappers), excluding the server-only routes (auth, sitemaps,
			// /api, the browse tree with its +page.server.ts) from the app build. Only
			// `files.routes` is overridden — the universal hook (src/hooks.ts reroute)
			// stays at its default location and works in both builds. `files` is
			// deprecated-but-supported in current SvelteKit; there is no non-deprecated
			// way to point at an alternate route tree, so we use it deliberately.
			...(IS_APP ? { files: { routes: 'src/routes-app' } } : {}),
			experimental: {
				// Enable SvelteKit remote functions (.remote.ts files). Harmless in the
				// app build — the remote modules are aliased away and never imported.
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
		// q-weighted) and on the client in src/hooks.client.ts (web: reads the
		// server-rendered <html lang>; app: resolves from navigator.language, since
		// the static shell carries no per-request locale). `baseLocale` ('en-US') is
		// the final fallback.
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
