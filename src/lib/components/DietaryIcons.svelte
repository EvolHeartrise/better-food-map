<script lang="ts">
	import type { Component } from 'svelte';
	import Vegan from '@lucide/svelte/icons/vegan';
	import Leaf from '@lucide/svelte/icons/leaf';
	import MilkOff from '@lucide/svelte/icons/milk-off';
	import NutOff from '@lucide/svelte/icons/nut-off';
	import WheatOff from '@lucide/svelte/icons/wheat-off';
	import FoodHalal from './icons/FoodHalal.svelte';
	import { tagDisplayName, type TagId } from '$lib/tags';

	// An item's DIETARY tags shown as small colored icons, sat to the right of the item
	// name in the venue panel. Positive-diet tags (vegan / vegetarian / halal) read
	// green; allergen-avoidance tags (dairy- / nut- / gluten-free) read orange. An
	// `optional` tag ("can be made vegan") gets a dashed ring — reusing the dashed =
	// optional convention the text pills used — and an "on request" accessible label.
	//
	// Course tags (dessert / drink) carry no icon here; they still render as text pills
	// elsewhere on the row. Only the six dietary ids are in ICONS, so any other tag id
	// falls through and renders nothing.

	// Just the item-tag fields this needs — kept structural so it doesn't reach into the
	// server-only db module for a type.
	interface ItemDietTag {
		id: string;
		name: string;
		optional: boolean;
	}

	let { tags }: { tags: ItemDietTag[] } = $props();

	type Tone = 'green' | 'orange';
	// Both the Lucide icons and the inlined FoodHalal accept a `size` prop and drive
	// their color from currentColor, so one component type covers both.
	type IconComponent = Component<{ size?: number | string }>;

	const ICONS: Partial<Record<TagId, { icon: IconComponent; tone: Tone }>> = {
		vegan: { icon: Vegan, tone: 'green' },
		vegetarian: { icon: Leaf, tone: 'green' },
		halal: { icon: FoodHalal, tone: 'green' },
		dairy_free: { icon: MilkOff, tone: 'orange' },
		nut_free: { icon: NutOff, tone: 'orange' },
		gluten_free: { icon: WheatOff, tone: 'orange' }
	};

	// Resolve each dietary tag to its glyph, dropping any tag we have no icon for
	// (dessert / drink). Order follows however the item lists its tags.
	const marks = $derived(
		tags.flatMap((tag) => {
			const spec = ICONS[tag.id as TagId];
			return spec ? [{ tag, spec }] : [];
		})
	);
</script>

{#if marks.length > 0}
	<ul class="diet-icons">
		{#each marks as { tag, spec } (tag.id)}
			{@const Icon = spec.icon}
			{@const label = tag.optional
				? `Can be made ${tagDisplayName(tag.name).toLowerCase()}`
				: tagDisplayName(tag.name)}
			<li class="diet-icons__item">
				<span
					class="diet-icons__mark diet-icons__mark--{spec.tone}"
					class:diet-icons__mark--optional={tag.optional}
					role="img"
					aria-label={label}
					title={label}
				>
					<Icon size={15} />
				</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.diet-icons {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.diet-icons__item {
		display: inline-flex;
	}

	/* The icon badge. A transparent border reserves the ring's space so an optional
	   mark (dashed ring) and an asserted one (no ring) stay the same size. currentColor
	   carries the tone to both the glyph and the ring. */
	.diet-icons__mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 1px;
		border: 1px solid transparent;
		border-radius: 999px;
		line-height: 0;
	}

	.diet-icons__mark--green {
		color: var(--color-accent);
	}

	.diet-icons__mark--orange {
		color: var(--color-caution);
	}

	/* An optional tag ("can be made vegan") reads as provisional, so it gets a dashed
	   ring — the same dashed cue the text pills used for optional tags. */
	.diet-icons__mark--optional {
		border-style: dashed;
		border-color: currentColor;
	}
</style>
