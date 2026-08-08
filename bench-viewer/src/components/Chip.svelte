<script lang="ts">
	/**
	 * Small round filter chip — a pressed/unpressed toggle. One wrapper so every
	 * facet chip in the app shares the same shape, pressed tint and focus ring.
	 */
	import type { Snippet } from 'svelte';
	import { Toggle } from '$lib/components/ui/toggle';

	let {
		pressed = false,
		disabled = false,
		title,
		onPressedChange,
		children
	}: {
		pressed?: boolean;
		disabled?: boolean;
		title?: string;
		onPressedChange?: (pressed: boolean) => void;
		children: Snippet;
	} = $props();
</script>

<Toggle
	{pressed}
	{disabled}
	{title}
	{onPressedChange}
	variant="outline"
	size="sm"
	class="h-6 min-w-0 rounded-full px-2.5 text-xs font-normal whitespace-nowrap aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-foreground"
>
	{@render children()}
</Toggle>
