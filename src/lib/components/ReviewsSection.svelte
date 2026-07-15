<script lang="ts">
	import StarRating from '$lib/components/StarRating.svelte';
	import ReviewEditor from '$lib/components/ReviewEditor.svelte';
	import ReviewList from '$lib/components/ReviewList.svelte';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import {
		getLocationReviews,
		setLocationReview,
		clearLocationReview,
		reportLocationReview
	} from '$lib/review.remote';
	import type { PublicReview, OwnReview } from '$lib/server/db';

	// The venue's ratings & reviews block in the detail panel: the aggregate summary,
	// the viewer's own interactive star rating (optimistic — owned by the page via
	// `onRate`), a review-text editor, and the paged public review list. Self-contained:
	// it imports the review remote functions directly (aliased to /api/v1 in the app
	// build), fetching/paging/reporting on its own, so the panel only wires the rating.
	let {
		locationId,
		signedIn,
		rating,
		onRate
	}: {
		locationId: string;
		signedIn: boolean;
		/** The viewer's current (optimistic) rating for this venue, 0 = none. */
		rating: number;
		/** Sets/clears the viewer's rating (1–5, or 0). Page-owned optimistic state. */
		onRate: (n: number) => void;
	} = $props();

	let summary = $state<{ count: number; average: number }>({ count: 0, average: 0 });
	let own = $state<OwnReview | null>(null);
	let reviews = $state<PublicReview[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(false);

	async function loadFirst(force = false): Promise<void> {
		loading = true;
		try {
			// On a venue change the arg is new, so the query fetches fresh on its own;
			// after a write (same id) `force` re-fetches via refresh() (which returns
			// void), then the await reads the updated value.
			if (force) await getLocationReviews({ locationId }).refresh();
			const data = await getLocationReviews({ locationId });
			summary = data.summary;
			own = data.own;
			reviews = data.reviews;
			nextCursor = data.nextCursor;
		} finally {
			loading = false;
		}
	}

	// (Re)load whenever the open venue changes.
	$effect(() => {
		void locationId;
		summary = { count: 0, average: 0 };
		own = null;
		reviews = [];
		nextCursor = null;
		void loadFirst();
	});

	async function loadMore(): Promise<void> {
		if (!nextCursor || loading) return;
		loading = true;
		try {
			const data = await getLocationReviews({ locationId, cursor: nextCursor });
			reviews = [...reviews, ...data.reviews];
			nextCursor = data.nextCursor;
		} finally {
			loading = false;
		}
	}

	async function saveText(text: string): Promise<void> {
		// Writes rating + text together; `rating` is the current optimistic value (the
		// editor's Save is disabled until a star is chosen, so it is ≥ 1 here).
		await setLocationReview({ locationId, rating, body: text });
		await loadFirst(true);
	}

	async function deleteReview(): Promise<void> {
		onRate(0); // clears the optimistic star (also deletes the row via the page queue)
		await clearLocationReview({ locationId }); // awaited copy so we can refresh after
		await loadFirst(true);
	}

	async function report(reviewId: string): Promise<void> {
		await reportLocationReview({ reviewId });
		await loadFirst(true);
	}

	// Fold the viewer's OWN optimistic rating into the server aggregate so the header
	// count/average react instantly to a bare star tap — which flows through the page's
	// rating queue, NOT this component, so `summary` alone would stay stale until the
	// next reload. `own.rating` is the viewer's rating already counted in `summary`
	// (unless their review is hidden, which the aggregate excludes); swap it for the
	// current optimistic `rating`. A hidden own review never contributes either way.
	// The viewer's own review is in the aggregate unless it's hidden (a hidden review
	// contributes to neither count nor average). A missing own review is "not hidden".
	const ownHidden = $derived(own !== null && own.hidden_at !== null);
	const ownCounts = $derived(own !== null && !ownHidden);
	const viewerCounts = $derived(rating > 0 && !ownHidden);
	const baseCount = $derived(summary.count - (ownCounts ? 1 : 0));
	const baseSum = $derived(summary.average * summary.count - (ownCounts ? (own?.rating ?? 0) : 0));
	const displayCount = $derived(baseCount + (viewerCounts ? 1 : 0));
	const displayAverage = $derived(
		displayCount > 0 ? (baseSum + (viewerCounts ? rating : 0)) / displayCount : 0
	);

	const avgLabel = $derived(
		new Intl.NumberFormat(getLocale(), {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1
		}).format(displayAverage)
	);
	const countLabel = $derived(new Intl.NumberFormat(getLocale()).format(displayCount));
</script>

<section class="rs" aria-label={m.reviews_heading()}>
	<h3 class="rs__heading">{m.reviews_heading()}</h3>

	{#if displayCount > 0}
		<div class="rs__summary">
			<StarRating value={displayAverage} size={16} />
			<span class="rs__avg" aria-label={m.reviews_average_aria({ average: avgLabel })}>
				{avgLabel}
			</span>
			<span class="rs__count">{m.reviews_count({ count: countLabel })}</span>
		</div>
	{:else}
		<p class="rs__empty">{m.reviews_none()}</p>
	{/if}

	{#if signedIn}
		<div class="rs__yours">
			<span class="rs__yours-label">{m.rating_your_label()}</span>
			<StarRating
				value={rating}
				{onRate}
				groupLabel={m.rating_your_label()}
				starLabel={(n) => m.rating_star_aria({ n })}
			/>
		</div>
		<ReviewEditor
			body={own?.body ?? null}
			canSave={rating > 0}
			hasReview={own !== null}
			hidden={ownHidden}
			onSave={saveText}
			onDelete={deleteReview}
		/>
	{:else}
		<p class="rs__signin">{m.review_signin_prompt()}</p>
	{/if}

	{#if reviews.length > 0}
		<ReviewList
			{reviews}
			hasMore={nextCursor !== null}
			{loading}
			{signedIn}
			onLoadMore={loadMore}
			onReport={report}
		/>
	{/if}
</section>

<style>
	.rs {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding-top: 0.75rem;
		margin-top: 0.75rem;
		border-top: 1px solid rgba(0, 0, 0, 0.1);
	}

	.rs__heading {
		margin: 0;
		font-size: 1rem;
		font-weight: 700;
	}

	.rs__summary {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.rs__avg {
		font-weight: 700;
	}

	.rs__count {
		font-size: 0.85rem;
		color: rgba(0, 0, 0, 0.6);
	}

	.rs__empty,
	.rs__signin {
		margin: 0;
		font-size: 0.9rem;
		color: rgba(0, 0, 0, 0.6);
	}

	.rs__yours {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.rs__yours-label {
		font-size: 0.85rem;
		font-weight: 600;
	}
</style>
