<script lang="ts">
	import type { Tag } from '$lib/server/db';
	import { tagDisplayName } from '$lib/tags';

	// A single tag, rendered as a styled pill. This is purely presentational: it
	// shows the tag's name and nothing else — no operator, no remove button, no
	// click handling. Anything interactive wraps a <FoodTag> rather than living
	// inside it, so the pill looks identical wherever a tag appears.
	//
	// Every tag is now dietary or course, which share one accent treatment, so the
	// pill has a single look. `tag` is accepted structurally (just its name) so both
	// a vocabulary `Tag` and an item's `ItemTag` satisfy it. `optional` marks a tag
	// that can be added or left out (e.g. "can be made vegan"); it's a per-item fact
	// carried by `ItemTag`, so callers pass `optional={tag.optional}`.
	let { tag, optional = false }: { tag: Pick<Tag, 'name'>; optional?: boolean } = $props();

	const label = $derived(tagDisplayName(tag.name) + (optional ? ' (optional)' : ''));
</script>

<span class="foodtag" class:foodtag--optional={optional}>
	{label}
</span>

<style>
	/* Dietary / course tags: the app's accent green. */
	.foodtag {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		white-space: nowrap;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	/* An optional tag reads as a hint rather than an asserted fact, so it's
	   de-emphasised with a dashed border. */
	.foodtag--optional {
		font-weight: 500;
		border-style: dashed;
	}
</style>
