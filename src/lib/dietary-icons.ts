// The dietary-tag glyphs and their tone, shared by the item-level icon row
// (DietaryIcons) and the diet filter selector (DietSelector) so the two can never
// drift. Positive-diet tags (vegan/vegetarian/halal) read green; allergen-avoidance
// tags (dairy-/nut-/gluten-free) read orange. Client-safe: no `$lib/server` import,
// mirroring how `$lib/tags` / `$lib/diet-profile` stay server-free.
//
// Icons are self-hosted: Lucide (ISC) for five of the six, plus the inlined
// mdi:food-halal glyph (Pictogrammers, Apache-2.0) as a local component — so the
// halal SVG ships in our bundle and is never fetched from a remote host. Both the
// Lucide icons and FoodHalal accept a `size` prop and take their color from
// currentColor, so one component type covers both.

import type { Component } from 'svelte';
import Vegan from '@lucide/svelte/icons/vegan';
import Leaf from '@lucide/svelte/icons/leaf';
import MilkOff from '@lucide/svelte/icons/milk-off';
import NutOff from '@lucide/svelte/icons/nut-off';
import WheatOff from '@lucide/svelte/icons/wheat-off';
import FoodHalal from './components/icons/FoodHalal.svelte';
import type { TagId } from './tags';

export type DietTone = 'green' | 'orange';
export type DietIconComponent = Component<{ size?: number | string }>;

export interface DietIcon {
	icon: DietIconComponent;
	tone: DietTone;
}

// Only the six dietary ids appear; course tags (dessert/drink) have no icon here.
const DIETARY_ICONS: Partial<Record<TagId, DietIcon>> = {
	vegan: { icon: Vegan, tone: 'green' },
	vegetarian: { icon: Leaf, tone: 'green' },
	halal: { icon: FoodHalal, tone: 'green' },
	dairy_free: { icon: MilkOff, tone: 'orange' },
	nut_free: { icon: NutOff, tone: 'orange' },
	gluten_free: { icon: WheatOff, tone: 'orange' }
};

/** The icon + tone for a dietary tag id (possibly untrusted), or undefined if none. */
export function dietIcon(id: string): DietIcon | undefined {
	return DIETARY_ICONS[id as TagId];
}
