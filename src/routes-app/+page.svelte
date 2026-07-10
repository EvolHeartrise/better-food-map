<script lang="ts">
	// Thin wrapper: the Capacitor build's home route renders the real map page.
	// Its `$lib/*.remote` imports are aliased to the /api/v1 shims (vite.config.ts).
	import RootPage from '../routes/+page.svelte';
</script>

<RootPage />
