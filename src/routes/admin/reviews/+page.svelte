<script lang="ts">
	// Review moderation console (admin-only; the load 403s non-admins). Lists the
	// reported/hidden reviews for locations and items with a hide / un-hide form per
	// row. Dev-facing internal tool — strings are plain English, not catalog keys.
	import type { PageData } from './$types';
	import type { ModerationReview } from '$lib/server/db';

	let { data }: { data: PageData } = $props();

	const sections: { target: 'location' | 'item'; title: string; rows: ModerationReview[] }[] =
		$derived([
			{ target: 'location', title: 'Location reviews', rows: data.locations },
			{ target: 'item', title: 'Item reviews', rows: data.items }
		]);

	function when(ms: number): string {
		return new Date(ms).toISOString().slice(0, 10);
	}
</script>

<svelte:head><title>Review moderation</title></svelte:head>

<main class="admin">
	<h1>Review moderation</h1>
	<p class="admin__note">
		Reviews with one or more reports, or already hidden. Auto-hidden reviews carry the reason
		<code>auto:reports</code>. Hiding removes a review from the public list and the aggregate.
	</p>

	{#each sections as section (section.target)}
		<section>
			<h2>{section.title} ({section.rows.length})</h2>
			{#if section.rows.length === 0}
				<p class="admin__empty">Nothing to moderate.</p>
			{:else}
				<table class="admin__table">
					<thead>
						<tr>
							<th>Venue / item</th>
							<th>Rating</th>
							<th>Review</th>
							<th>Reports</th>
							<th>Status</th>
							<th>Action</th>
						</tr>
					</thead>
					<tbody>
						{#each section.rows as row (row.id)}
							<tr class:admin__row--hidden={row.hidden_at != null}>
								<td>{row.target_name}</td>
								<td>{row.rating}★</td>
								<td>
									<div class="admin__body">{row.body ?? '—'}</div>
									<div class="admin__meta">
										by {row.author_name ?? 'Anonymous'} · {when(row.created_at)}
									</div>
								</td>
								<td>{row.report_count}</td>
								<td>
									{#if row.hidden_at != null}
										hidden{row.hidden_reason ? ` (${row.hidden_reason})` : ''}
									{:else}
										visible
									{/if}
								</td>
								<td>
									<form method="POST" action={row.hidden_at != null ? '?/unhide' : '?/hide'}>
										<input type="hidden" name="target" value={section.target} />
										<input type="hidden" name="reviewId" value={row.id} />
										<button type="submit">{row.hidden_at != null ? 'Un-hide' : 'Hide'}</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/each}
</main>

<style>
	.admin {
		max-width: 60rem;
		margin: 0 auto;
		padding: 1.5rem 1rem;
		font-family: system-ui, sans-serif;
	}

	.admin__note {
		color: #444;
		font-size: 0.9rem;
	}

	.admin__empty {
		color: #666;
	}

	.admin__table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}

	.admin__table th,
	.admin__table td {
		border: 1px solid rgba(0, 0, 0, 0.15);
		padding: 0.4rem 0.5rem;
		text-align: left;
		vertical-align: top;
	}

	.admin__row--hidden {
		background: rgba(185, 28, 28, 0.06);
	}

	.admin__body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-width: 24rem;
	}

	.admin__meta {
		color: #666;
		font-size: 0.78rem;
		margin-top: 0.2rem;
	}

	.admin__table button {
		padding: 0.25rem 0.6rem;
		cursor: pointer;
	}
</style>
