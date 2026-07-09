<script lang="ts">
	import type { Snippet } from 'svelte';

	// The chrome shared by every geographic browse page (#217): a brand header, a
	// breadcrumb up the tree, the H1 and lead paragraph, then the page's own list.
	// A plain scrollable document (unlike the fixed-viewport map at `/`), so these
	// pages read and crawl like ordinary content. All links arrive as ready-built
	// hrefs (from $lib/browse) so the template holds no literal route strings.
	let {
		crumbs,
		current,
		title,
		intro,
		children
	}: {
		// Ancestor links, root-first (Map, Places, Canada, …) — each a real crawlable <a>.
		crumbs: { href: string; label: string }[];
		// The current page's short breadcrumb label (rendered as plain text, not a link).
		current: string;
		// The page <h1>.
		title: string;
		// A one-line lead under the H1 (optional).
		intro?: string;
		// The page body — typically a <BrowseLinkList>.
		children: Snippet;
	} = $props();
</script>

<div class="browse">
	<header class="browse__top">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pre-built internal href ($lib/browse); no base path — see +page.svelte precedent -->
		<a class="browse__brand" href={crumbs[0]?.href ?? '/'}>🍴 BetterFoodMaps</a>
	</header>

	<nav class="browse__crumbs" aria-label="Breadcrumb">
		<ol>
			{#each crumbs as crumb (crumb.href)}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pre-built internal href ($lib/browse); no base path — see +page.svelte precedent -->
				<li><a href={crumb.href}>{crumb.label}</a></li>
			{/each}
			<li aria-current="page">{current}</li>
		</ol>
	</nav>

	<h1 class="browse__title">{title}</h1>
	{#if intro}
		<p class="browse__intro">{intro}</p>
	{/if}

	{@render children()}
</div>

<style>
	.browse {
		max-width: 60rem;
		margin: 0 auto;
		padding: clamp(1.25rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2rem) 4rem;
	}

	.browse__top {
		margin-bottom: 1.5rem;
	}

	.browse__brand {
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-accent);
	}

	.browse__brand:hover {
		text-decoration: none;
	}

	/* A wrapping breadcrumb trail; each level separated by a chevron via ::before. */
	.browse__crumbs ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.15rem 0.4rem;
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.browse__crumbs li + li::before {
		content: '›';
		margin-right: 0.4rem;
		color: var(--color-border);
	}

	.browse__crumbs a {
		color: var(--color-text-muted);
	}

	.browse__crumbs [aria-current='page'] {
		color: var(--color-text);
		font-weight: 600;
	}

	.browse__title {
		font-size: clamp(1.5rem, 4vw, 2.1rem);
		margin: 0 0 0.4rem;
	}

	.browse__intro {
		margin: 0 0 1.75rem;
		max-width: 42rem;
		color: var(--color-text-muted);
	}
</style>
