import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * The bench analytics viewer is a plain Vite + Svelte SPA, deliberately NOT a
 * SvelteKit app and deliberately not part of the main application build:
 *
 * - It is internal tooling served from localhost by `bun run bench:viewer`, so it
 *   needs no SSR, no adapter and no router framework.
 * - The main app is Cloudflare-bound and runs every user-facing string through
 *   the Paraglide message catalog across 27 locales. An internal dashboard has no
 *   business paying that tax, and keeping it out of `src/` keeps the rule honest.
 *
 * Svelte compiler options live here rather than in a `svelte.config.js`, matching
 * the repo convention (kit/compiler config is passed to the plugin; a
 * `svelte.config.js` would be ignored).
 */
export default defineConfig({
	// `experimental.async` lets data live in `$derived(await …)` instead of an
	// $effect that assigns state, and gives synchronized updates for free: on a
	// refilter Svelte holds the rendered table until the new data resolves, so
	// there is no skeleton flash between slices.
	plugins: [svelte({ compilerOptions: { runes: true, experimental: { async: true } } })],
	// Relative asset URLs so the bundle works from any mount path the viewer serves.
	base: './',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		// The viewer is read locally over localhost; a source map costs nothing here
		// and makes a stack trace in the console actionable.
		sourcemap: true
	},
	server: {
		port: 8793,
		strictPort: true,
		// `vite dev` for UI iteration; the API keeps coming from `bench:viewer`.
		proxy: { '/api': 'http://127.0.0.1:8792' }
	}
});
