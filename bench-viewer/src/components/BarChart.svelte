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

	const BAR = 18;
	const GAP = 10;
	const LABEL_WIDTH = 190;
	const VALUE_WIDTH = 74;

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

<div
	class="chart"
	style="--bar:{BAR}px;--gap:{GAP}px;--label:{LABEL_WIDTH}px;--value:{VALUE_WIDTH}px"
>
	{#each bars as bar (bar.label)}
		<div class="row">
			<div class="label" title={bar.label}>
				{bar.label}
				{#if bar.note}<span class="note">{bar.note}</span>{/if}
			</div>
			<div class="track">
				{#if bar.value !== null}
					<div class="bar" style="width:{width(bar.value)}%"></div>
				{/if}
			</div>
			<div class="value num">{bar.value === null ? '—' : format(bar.value)}</div>
		</div>
	{/each}
</div>

<style>
	.chart {
		display: flex;
		flex-direction: column;
		gap: var(--gap);
	}

	.row {
		display: grid;
		grid-template-columns: var(--label) 1fr var(--value);
		align-items: center;
		gap: 10px;
	}

	.label {
		font-size: 12px;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note {
		color: var(--text-muted);
		margin-left: 6px;
		font-size: 11px;
	}

	.track {
		height: var(--bar);
		background: color-mix(in srgb, var(--gridline) 60%, transparent);
		border-radius: 3px;
		overflow: hidden;
	}

	.bar {
		height: 100%;
		background: var(--series-1);
		/* Rounded data-end, square at the baseline. */
		border-radius: 0 4px 4px 0;
		min-width: 2px;
	}

	.value {
		font-size: 12px;
		text-align: right;
		color: var(--text-primary);
	}
</style>
