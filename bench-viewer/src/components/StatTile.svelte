<script lang="ts">
	/**
	 * Stat tile: label · value · optional note. Proportional figures on the value
	 * (tabular-nums makes a big standalone number look loose); the note carries
	 * the caveat that stops the number being read as more than it is.
	 */
	import * as Card from '$lib/components/ui/card';

	let {
		label,
		value,
		note,
		tone = 'plain'
	}: {
		label: string;
		value: string;
		note?: string;
		tone?: 'plain' | 'warn' | 'bad';
	} = $props();
</script>

<Card.Root size="sm" class="min-w-0 gap-0 px-3.5 py-3">
	<div class="text-xs text-muted-foreground">{label}</div>
	<div
		class="mt-0.5 text-2xl leading-tight font-semibold tracking-tight {tone === 'warn'
			? 'text-serious'
			: tone === 'bad'
				? 'text-critical'
				: ''}"
	>
		{value}
	</div>
	{#if note}<div class="mt-0.5 text-[11px] text-muted-foreground">{note}</div>{/if}
</Card.Root>
