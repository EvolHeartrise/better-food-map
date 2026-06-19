<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="app-header">
	<div class="app-header__inner">
		<a class="app-header__brand" href={resolve('/')}>Better Food Map</a>
	</div>
</header>

<main>
	{@render children()}
</main>
