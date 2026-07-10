<script lang="ts">
	import { onMount } from 'svelte';
	import RootLayout from '../routes/+layout.svelte';
	import { initApp } from '$lib/app/bootstrap';

	// Thin wrapper over the real root layout for the Capacitor build. Adds the
	// one-time app bootstrap (token load, deep-link + external-link listeners) and
	// otherwise renders the exact same chrome as the web layout.
	let { children } = $props();

	onMount(() => initApp());
</script>

<RootLayout>{@render children()}</RootLayout>
