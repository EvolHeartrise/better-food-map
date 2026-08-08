<script lang="ts">
	/**
	 * Column-sort header button. A real <button> because a click handler on a <th>
	 * is unreachable by keyboard and announces no sort state; the ▲/▼ glyph makes
	 * the active sort visible, while aria-sort on the <th> announces it.
	 */
	import type { Snippet } from 'svelte';

	let {
		active = false,
		desc = true,
		title,
		onclick,
		children
	}: {
		active?: boolean;
		desc?: boolean;
		title?: string;
		onclick: () => void;
		children: Snippet;
	} = $props();
</script>

<button
	class="inline-flex cursor-pointer items-center gap-0.5 rounded-sm text-xs font-semibold select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {active
		? 'text-foreground'
		: 'text-muted-foreground hover:text-foreground'}"
	{title}
	{onclick}
>
	{@render children()}{#if active}<span aria-hidden="true" class="text-[9px]"
			>{desc ? '▼' : '▲'}</span
		>{/if}
</button>
