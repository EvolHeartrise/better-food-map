<script lang="ts">
	/**
	 * Horizontal bars for one measure across named categories.
	 *
	 * One series, one colour (categorical slot 1) — a value ramp across nominal
	 * categories would double-encode length as hue and burn the only free channel
	 * on information the bar already shows. Values ride the bar tip; the axis is
	 * left implicit because every bar is labelled.
	 */
	let {
		bars,
		format,
		max
	}: {
		bars: { label: string; value: number | null; note?: string }[];
		format: (value: number) => string;
		max?: number;
	} = $props();

	let domainMax = $derived(
		max ??
			Math.max(
				...bars.map((bar) => bar.value ?? 0).filter((value) => Number.isFinite(value)),
				Number.EPSILON
			)
	);

	function width(value: number | null): number {
		if (value === null || domainMax <= 0) return 0;
		return Math.max(0, (value / domainMax) * 100);
	}
</script>

<div class="flex flex-col gap-2.5">
	{#each bars as bar (bar.label)}
		<div class="grid grid-cols-[190px_1fr_74px] items-center gap-2.5">
			<div class="truncate text-xs text-muted-foreground" title={bar.label}>
				{bar.label}
				{#if bar.note}<span class="ml-1.5 text-[11px] text-muted-foreground/70">{bar.note}</span
					>{/if}
			</div>
			<div class="h-[18px] overflow-hidden rounded-[3px] bg-gridline/60">
				{#if bar.value !== null}
					<!-- Rounded data-end, square at the baseline. -->
					<div
						class="h-full min-w-[2px] rounded-r bg-series-1"
						style="width:{width(bar.value)}%"
					></div>
				{/if}
			</div>
			<div class="text-right text-xs tabular-nums">
				{bar.value === null ? '—' : format(bar.value)}
			</div>
		</div>
	{/each}
</div>
