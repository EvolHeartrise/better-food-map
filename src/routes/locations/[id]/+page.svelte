<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { getLocation } from '$lib/data.remote';

	const location = $derived(await getLocation(page.params.id ?? ''));

	const currency = new Intl.NumberFormat('en-CA', {
		style: 'currency',
		currency: 'CAD'
	});

	const categoryLabels = {
		cafe: 'Cafe',
		fast_food: 'Fast food',
		restaurant: 'Restaurant'
	};

	function formatPrice(price: number | null): string {
		return price === null ? '—' : currency.format(price);
	}

	function ingredientList(ingredients: string | null): string[] {
		if (!ingredients) return [];
		return ingredients
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}
</script>

<svelte:head>
	<title>{location ? location.name : 'Location'} · Better Food Map</title>
</svelte:head>

<svelte:boundary>
	<div class="page">
		{#if location === null}
			<section class="not-found">
				<h1>We couldn't find that place.</h1>
				<p>The location you're looking for doesn't exist or may have been removed.</p>
				<a class="back-link" href={resolve('/')}>← Back to map</a>
			</section>
		{:else}
			<article>
				<header class="location-header">
					<h1>{location.name}</h1>
					{#if location.category}
						<span class="badge">{categoryLabels[location.category]}</span>
					{/if}
				</header>

				<dl class="info">
					{#if location.address}
						<div class="info__row">
							<dt>Address</dt>
							<dd>{location.address}</dd>
						</div>
					{/if}
					{#if location.phone}
						<div class="info__row">
							<dt>Phone</dt>
							<dd><a href="tel:{location.phone}">{location.phone}</a></dd>
						</div>
					{/if}
					{#if location.website}
						<div class="info__row">
							<dt>Website</dt>
							<dd>
								<a href={location.website} target="_blank" rel="external noopener noreferrer">
									{location.website}
								</a>
							</dd>
						</div>
					{/if}
					<div class="info__row">
						<dt>Coordinates</dt>
						<dd>{location.latitude}, {location.longitude}</dd>
					</div>
				</dl>

				<section class="menu">
					<h2>Menu</h2>
					{#if location.menu.length === 0}
						<p class="empty">Menu information isn't available for this place yet.</p>
					{:else}
						<ul class="menu__list">
							{#each location.menu as item (item.id)}
								<li class="menu__item">
									<div class="menu__line">
										<span class="menu__name">{item.item_name}</span>
										<span class="menu__price">{formatPrice(item.price)}</span>
									</div>
									{#if ingredientList(item.ingredients).length > 0}
										<ul class="ingredients">
											{#each ingredientList(item.ingredients) as ingredient (ingredient)}
												<li class="ingredient">{ingredient}</li>
											{/each}
										</ul>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<a class="back-link" href={resolve('/')}>← Back to map</a>
			</article>
		{/if}
	</div>

	{#snippet pending()}
		<div class="page">
			<p class="loading">Loading…</p>
		</div>
	{/snippet}
</svelte:boundary>

<style>
	.page {
		width: 100%;
		max-width: var(--container-width);
		margin: 0 auto;
		padding: 2rem 1.25rem 3rem;
	}

	.loading {
		color: var(--color-text-muted);
	}

	.not-found {
		text-align: center;
		padding: 3rem 0;
	}

	.not-found p {
		color: var(--color-text-muted);
		margin: 0 0 1.5rem;
	}

	.location-header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 1.25rem;
	}

	.location-header h1 {
		margin: 0;
	}

	.badge {
		display: inline-block;
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		background-color: var(--color-accent);
		color: #fff;
		font-size: 0.8rem;
		font-weight: 600;
		line-height: 1.4;
		white-space: nowrap;
	}

	.info {
		display: grid;
		gap: 0.5rem;
		margin: 0 0 2rem;
		padding: 1rem 1.25rem;
		background-color: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-sm);
	}

	.info__row {
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.5rem 1rem;
		align-items: baseline;
	}

	.info dt {
		color: var(--color-text-muted);
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.info dd {
		margin: 0;
		word-break: break-word;
	}

	.menu {
		margin-bottom: 2rem;
	}

	.empty {
		color: var(--color-text-muted);
		font-style: italic;
	}

	.menu__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}

	.menu__item {
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.menu__item:last-child {
		border-bottom: none;
	}

	.menu__line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	.menu__name {
		font-weight: 600;
	}

	.menu__price {
		color: var(--color-text);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.ingredients {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0.4rem 0 0;
		padding: 0;
	}

	.ingredient {
		font-size: 0.8rem;
		color: var(--color-text-muted);
		background-color: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.1rem 0.55rem;
	}

	.back-link {
		display: inline-block;
		margin-top: 0.5rem;
		font-weight: 500;
	}
</style>
