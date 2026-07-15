<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import StarRating from '$lib/components/StarRating.svelte';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { PublicReview } from '$lib/server/db';

	// The public review list for the open venue/item: each attributed review's author,
	// stars, date and prose (rendered as PLAIN TEXT — Svelte auto-escapes {review.body},
	// never {@html} — this is the app's first user-generated display surface), a Report
	// affordance, and keyset "show more" paging. The parent owns fetching/paging and the
	// report command; this component renders and reports intent.
	let {
		reviews,
		hasMore,
		loading = false,
		signedIn,
		onLoadMore,
		onReport
	}: {
		reviews: PublicReview[];
		hasMore: boolean;
		loading?: boolean;
		signedIn: boolean;
		onLoadMore: () => void;
		onReport: (reviewId: string) => Promise<void>;
	} = $props();

	// Ids the viewer has reported this session, so the button flips to a settled state.
	const reported = new SvelteSet<string>();

	const dateFmt = $derived(
		new Intl.DateTimeFormat(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' })
	);

	async function report(id: string): Promise<void> {
		if (reported.has(id)) return;
		await onReport(id);
		reported.add(id);
	}
</script>

<ul class="reviews">
	{#each reviews as review (review.id)}
		<li class="review">
			<div class="review__head">
				{#if review.author_picture}
					<img
						class="review__avatar"
						src={review.author_picture}
						alt=""
						referrerpolicy="no-referrer"
					/>
				{:else}
					<span class="review__avatar review__avatar--blank" aria-hidden="true"></span>
				{/if}
				<span class="review__author">{review.author_name ?? m.review_anonymous()}</span>
				<time class="review__date" datetime={new Date(review.created_at).toISOString()}>
					{dateFmt.format(review.created_at)}
				</time>
			</div>
			<StarRating value={review.rating} size={14} />
			{#if review.body}
				<p class="review__body">{review.body}</p>
			{/if}
			{#if signedIn}
				<button
					type="button"
					class="review__report"
					disabled={reported.has(review.id)}
					onclick={() => report(review.id)}
				>
					{reported.has(review.id) ? m.review_reported() : m.review_report()}
				</button>
			{/if}
		</li>
	{/each}
</ul>

{#if hasMore}
	<button type="button" class="reviews__more" disabled={loading} onclick={onLoadMore}>
		{loading ? m.review_loading() : m.review_load_more()}
	</button>
{/if}

<style>
	.reviews {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.review {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.review__head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.review__avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		object-fit: cover;
		flex: none;
	}

	.review__avatar--blank {
		background: rgba(0, 0, 0, 0.12);
	}

	.review__author {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.review__date {
		margin-left: auto;
		font-size: 0.8rem;
		color: rgba(0, 0, 0, 0.55);
	}

	.review__body {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.review__report {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: transparent;
		font: inherit;
		font-size: 0.78rem;
		color: rgba(0, 0, 0, 0.55);
		cursor: pointer;
		text-decoration: underline;
	}

	.review__report:disabled {
		cursor: default;
		text-decoration: none;
		color: rgba(0, 0, 0, 0.4);
	}

	.reviews__more {
		margin-top: 0.75rem;
		padding: 0.4rem 0.9rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		border-radius: 999px;
		background: transparent;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
</style>
