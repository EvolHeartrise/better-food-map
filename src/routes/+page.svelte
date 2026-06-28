<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getCurrentUser } from '$lib/user.remote';
	import { safeInternalPath } from '$lib/redirect';
	import LogIn from '@lucide/svelte/icons/log-in';
	import MapIcon from '@lucide/svelte/icons/map';

	// The landing page sits in front of the (sign-in-gated) map. The signed-in user —
	// null when signed out — decides whether it offers a Google sign-in or a way into
	// the app. Read via the remote query (awaited so the correct control is in the
	// server-rendered HTML, no flash); mirrors how the map page reads the user.
	const user = $derived(await getCurrentUser());

	// After sign-in, return the visitor to where they were headed: the auth gate sets
	// `?redirectTo` to the protected URL it bounced (e.g. a shared location link), and
	// the map otherwise. Validated to a same-origin path here too, before it's woven
	// into the login link the same way the login route and callback validate it.
	const redirectTo = $derived(safeInternalPath(page.url.searchParams.get('redirectTo')));
	// The login route's path goes through `resolve` (satisfying the typed-navigation
	// lint rule); the destination rides along as a query param it reads back.
	const loginHref = $derived(
		`${resolve('/auth/login/google')}?redirectTo=${encodeURIComponent(redirectTo)}`
	);
</script>

<svelte:head>
	<title>BetterFoodMaps — Find food that fits your diet</title>
	<meta
		name="description"
		content="Sign in to explore cafes, fast food and restaurants on an interactive map, filtered to your dietary needs."
	/>
</svelte:head>

<div class="landing">
	<section class="hero">
		<p class="hero__brand">🍴 BetterFoodMaps</p>
		<h1 class="hero__title">Find food that fits your diet, anywhere on the map.</h1>
		<p class="hero__tagline">
			Search restaurants, cafes and fast food by what's actually on the menu — vegan, gluten-free,
			halal and more.
		</p>

		{#if user}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated same-origin path (safeInternalPath), defaults to /map -->
			<a class="cta" href={redirectTo}>
				<MapIcon size={18} aria-hidden="true" />
				Open the map
			</a>
		{:else}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved login path with the redirectTo query the login route reads -->
			<a class="cta" href={loginHref}>
				<LogIn size={18} aria-hidden="true" />
				Sign in with Google
			</a>
			<p class="hero__note">Sign in to start exploring the map.</p>
		{/if}
	</section>
</div>

<style>
	/* Fills the viewport and centres the hero. A soft accent-tinted wash over the app
	   background so the page reads as a branded front door rather than a bare form. */
	.landing {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 2rem calc(1.5rem + env(safe-area-inset-right)) 2rem
			calc(1.5rem + env(safe-area-inset-left));
		background:
			radial-gradient(
				120% 120% at 50% 0%,
				color-mix(in srgb, var(--color-accent) 14%, transparent),
				transparent 60%
			),
			var(--color-bg);
	}

	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		max-width: 34rem;
		padding: 2.5rem 2rem;
		text-align: center;
		border-radius: 1.25rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14);
	}

	.hero__brand {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 650;
		letter-spacing: 0.01em;
		color: var(--color-accent);
	}

	.hero__title {
		margin: 0;
		font-size: clamp(1.6rem, 4vw, 2.4rem);
		color: var(--color-text);
	}

	.hero__tagline {
		margin: 0;
		font-size: 1rem;
		color: var(--color-text-muted);
	}

	/* The primary action — accent-filled so the sign-in / map entry is unmistakable. */
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.5rem;
		padding: 0.7rem 1.3rem;
		border-radius: 0.8rem;
		background: var(--color-accent);
		color: #fff;
		font-size: 1rem;
		font-weight: 600;
		text-decoration: none;
		box-shadow: 0 6px 20px color-mix(in srgb, var(--color-accent) 35%, transparent);
		transition:
			background-color 0.12s,
			transform 0.12s;
	}

	.cta:hover {
		background: var(--color-accent-hover);
		text-decoration: none;
	}

	.cta:active {
		transform: translateY(1px);
	}

	.cta:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.hero__note {
		margin: 0;
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}
</style>
