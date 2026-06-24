<script lang="ts">
	import type { Tag } from '$lib/server/db';
	import { tagDisplayName } from '$lib/tags';

	// A single tag, rendered as a styled pill. This is purely presentational: it
	// shows the tag's name with the right colour for its type, and nothing else —
	// no operator ("is"/"not"), no remove button, no click handling. Anything
	// interactive (a removable filter chip, a toggleable option row) wraps a
	// <FoodTag> rather than living inside it, so the pill looks identical wherever
	// a tag appears.
	//
	// `tag` is accepted structurally (just name + tag_type) so both a vocabulary
	// `Tag` and an item's `ItemTag` satisfy it. `optional` marks a tag that can be
	// added or left out (e.g. "can be made vegan", cheese on request); it's a
	// per-item fact carried by `ItemTag`, so callers pass `optional={tag.optional}`.
	let { tag, optional = false }: { tag: Pick<Tag, 'name' | 'tag_type'>; optional?: boolean } =
		$props();

	// Dietary and course tags share the accent treatment; ingredient tags are the
	// muted variant. (Course tags live in the same green family as dietary ones in
	// the current design, so they collapse together here.)
	const variant = $derived(tag.tag_type === 'ingredient' ? 'ingredient' : 'dietary');
	const label = $derived(tagDisplayName(tag.name) + (optional ? ' (optional)' : ''));
</script>

<span class="foodtag foodtag--{variant}" class:foodtag--optional={optional}>
	{label}
</span>

<style>
	.foodtag {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		white-space: nowrap;
	}

	/* Dietary / course tags: the app's accent green. */
	.foodtag--dietary {
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	/* Ingredient tags: a quieter, neutral pill (and a lighter weight). */
	.foodtag--ingredient {
		font-weight: 400;
		color: var(--color-text-muted);
		background-color: rgba(255, 255, 255, 0.6);
		border: 1px solid var(--color-border);
	}

	/* An optional tag/ingredient reads as a hint rather than an asserted fact, so
	   it's de-emphasised with a dashed border. Listed last so its weight wins for
	   an optional ingredient (which would otherwise take the variant's 400). */
	.foodtag--optional {
		font-weight: 500;
		border-style: dashed;
	}
</style>
