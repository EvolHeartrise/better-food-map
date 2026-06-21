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
		})
	]
});
