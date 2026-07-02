<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	// A friendly one-liner for the common cases; anything else shows the error
	// message SvelteKit provides (expected errors carry their own, unexpected
	// ones are redacted to "Internal Error").
	const message = $derived(
		page.status === 404
			? "This page doesn't exist"
			: (page.error?.message ?? 'Something went wrong')
	);
</script>

<svelte:head>
	<title>{page.status} · BetterFoodMaps</title>
</svelte:head>

<div class="error">
	<div class="error__card">
		<p class="error__brand">BetterFoodMaps</p>
		<p class="error__status">{page.status}</p>
		<h1 class="error__message">{message}</h1>
		<a class="error__link" href={resolve('/')}>Back to the map</a>
	</div>
</div>

<style>
	/* Fills the viewport (the root layout's <main> adds no chrome) with the app
	   background plus a soft accent glow, so the floating card reads like the
	   map's glass panels rather than a bare document. */
	.error {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
		background:
			radial-gradient(
				60rem 40rem at 50% -10%,
				color-mix(in srgb, var(--color-accent) 14%, transparent),
				transparent 70%
			),
			var(--color-bg);
	}

	/* Same glass surface as the map's detail card (+page.svelte .placecard). */
	.error__card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		width: min(24rem, 100%);
		padding: 2.25rem 2rem;
		text-align: center;
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 10px 34px rgba(0, 0, 0, 0.22);
	}

	.error__brand {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-accent);
	}

	.error__status {
		margin: 0;
		font-size: 3.5rem;
		font-weight: 700;
		line-height: 1;
		color: var(--color-text);
		font-variant-numeric: tabular-nums;
	}

	.error__message {
		margin: 0;
		font-size: 1rem;
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.error__link {
		display: inline-block;
		margin-top: 1rem;
		padding: 0.5rem 1.1rem;
		font-size: 0.9rem;
		font-weight: 600;
		color: #fff;
		background: var(--color-accent);
		border: 1px solid var(--color-accent);
		border-radius: 999px;
		transition: background-color 0.12s;
	}

	.error__link:hover {
		background: var(--color-accent-hover);
		text-decoration: none;
	}
</style>
