<script lang="ts">
	// The list body of a browse page: a column of crawlable links. Used for every
	// level — country/region/city index rows (label + count) and a city's venue
	// rows (name + address). All hrefs are pre-built (from $lib/browse or
	// locationPath) so no route string is written inline here.
	let {
		items,
		label
	}: {
		items: { href: string; label: string; sublabel?: string; count?: number }[];
		// Accessible name for the list (e.g. "Provinces", "Places in Toronto").
		label: string;
	} = $props();

	const numberFormat = new Intl.NumberFormat('en-CA');
</script>

<ul class="list" aria-label={label}>
	{#each items as item (item.href)}
		<li>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pre-built internal href ($lib/browse / locationPath); no base path, and venue links are synthetic (no route), so typed resolve() can't apply — see +page.svelte precedent -->
			<a class="list__link" href={item.href}>
				<span class="list__text">
					<span class="list__label">{item.label}</span>
					{#if item.sublabel}
						<span class="list__sublabel">{item.sublabel}</span>
					{/if}
				</span>
				{#if item.count !== undefined}
					<span class="list__count">{numberFormat.format(item.count)}</span>
				{/if}
			</a>
		</li>
	{/each}
</ul>

<style>
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	/* A card row: name/address on the left, count pinned right. */
	.list__link {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.7rem 0.9rem;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-sm);
		transition:
			border-color 0.12s,
			transform 0.06s;
	}

	.list__link:hover {
		text-decoration: none;
		border-color: var(--color-accent);
	}

	.list__link:active {
		transform: translateY(1px);
	}

	.list__text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.list__label {
		font-weight: 600;
	}

	.list__sublabel {
		font-size: 0.82rem;
		color: var(--color-text-muted);
	}

	.list__count {
		flex-shrink: 0;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}
</style>
