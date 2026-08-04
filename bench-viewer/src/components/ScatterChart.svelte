<script lang="ts">
	/**
	 * Quality-vs-cost (or vs latency) scatter with the Pareto frontier called out.
	 *
	 * One series colour, not one per model. With five-plus models a categorical
	 * palette cannot clear the all-pairs colourblind floor that scatter demands,
	 * and colour would be doing work the labels already do better: the frontier
	 * points are direct-labelled, everything else is one step back, and identity
	 * comes from the hover tooltip and the table view beneath the chart.
	 */
	import { UNKNOWN } from '../lib/format';
	import type { ScatterPoint } from '../lib/types';

	let {
		points,
		xLabel,
		yLabel,
		formatX,
		formatY,
		logX = true,
		onselect
	}: {
		points: ScatterPoint[];
		xLabel: string;
		yLabel: string;
		formatX: (value: number) => string;
		formatY: (value: number) => string;
		logX?: boolean;
		onselect?: (id: string) => void;
	} = $props();

	const WIDTH = 760;
	const HEIGHT = 380;
	const PAD = { top: 16, right: 24, bottom: 44, left: 56 };

	let hovered = $state<ScatterPoint | null>(null);

	// A log x-axis is what makes a cost frontier readable — runs here span three
	// orders of magnitude — but log(0) is undefined, so a free/zero-cost point
	// would silently vanish. Fall back to linear when any x is non-positive.
	let useLog = $derived(logX && points.every((point) => point.x > 0));

	let xDomain = $derived.by(() => {
		const values = points.map((point) => point.x);
		if (values.length === 0) return [0, 1];
		const min = Math.min(...values);
		const max = Math.max(...values);
		if (min === max) return useLog ? [min / 2, max * 2] : [0, max * 1.2 || 1];
		return useLog ? [min * 0.8, max * 1.25] : [Math.min(0, min), max * 1.05];
	});

	let yDomain = $derived.by(() => {
		const values = points.map((point) => point.y);
		if (values.length === 0) return [0, 1];
		const min = Math.min(...values);
		const max = Math.max(...values);
		// Quality metrics cluster near 1; a 0-based axis would flatten every
		// difference that matters. Pad the observed band instead.
		const span = Math.max(max - min, 0.02);
		return [Math.max(0, min - span * 0.15), Math.min(1, max + span * 0.15)];
	});

	function scaleX(value: number): number {
		const [lo, hi] = xDomain;
		const t = useLog
			? (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
			: (value - lo) / (hi - lo);
		return PAD.left + t * (WIDTH - PAD.left - PAD.right);
	}

	function scaleY(value: number): number {
		const [lo, hi] = yDomain;
		const t = (value - lo) / (hi - lo || 1);
		return HEIGHT - PAD.bottom - t * (HEIGHT - PAD.top - PAD.bottom);
	}

	/** Clean tick values: decades on a log axis, five even steps otherwise. */
	let xTicks = $derived.by(() => {
		const [lo, hi] = xDomain;
		if (!useLog) {
			return Array.from({ length: 5 }, (_unused, i) => lo + ((hi - lo) * i) / 4);
		}
		const ticks: number[] = [];
		for (let exp = Math.floor(Math.log10(lo)); exp <= Math.ceil(Math.log10(hi)); exp++) {
			const value = 10 ** exp;
			if (value >= lo && value <= hi) ticks.push(value);
		}
		return ticks.length >= 2 ? ticks : [lo, hi];
	});

	let yTicks = $derived.by(() => {
		const [lo, hi] = yDomain;
		return Array.from({ length: 5 }, (_unused, i) => lo + ((hi - lo) * i) / 4);
	});

	/** Frontier points, left to right, so the connecting path reads as a step-up. */
	let frontierPath = $derived.by(() => {
		const sorted = points.filter((point) => point.frontier).toSorted((a, b) => a.x - b.x);
		if (sorted.length < 2) return '';
		return sorted
			.map((point, i) => `${i === 0 ? 'M' : 'L'}${scaleX(point.x)},${scaleY(point.y)}`)
			.join(' ');
	});

	/**
	 * Direct labels for the frontier, placed so they never overlap.
	 *
	 * Frontier points cluster, and stacking or nudging collided labels detaches
	 * them from their marks and reads as noise. So each label is tried above its
	 * point, then below, and DROPPED if neither fits — the table view under the
	 * chart carries every row, so a dropped label loses nothing. Labels are also
	 * kept inside the plot box, since a clipped label is worse than no label.
	 */
	const LABEL_HEIGHT = 13;
	const CHAR_WIDTH = 5.4; // 10px system sans, close enough for collision boxes

	interface PlacedLabel {
		id: string;
		text: string;
		x: number;
		y: number;
		anchor: 'start' | 'middle' | 'end';
	}

	let placedLabels = $derived.by<PlacedLabel[]>(() => {
		const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
		const placed: PlacedLabel[] = [];
		const left = PAD.left;
		const right = WIDTH - PAD.right;

		const overlaps = (box: (typeof boxes)[number]) =>
			boxes.some(
				(other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0
			);

		for (const point of points.filter((entry) => entry.frontier).toSorted((a, b) => a.x - b.x)) {
			const width = point.label.length * CHAR_WIDTH;
			const cx = scaleX(point.x);
			const cy = scaleY(point.y);

			// Keep the text box inside the plot by switching anchor near an edge.
			let anchor: PlacedLabel['anchor'] = 'middle';
			let x0 = cx - width / 2;
			if (x0 < left) {
				anchor = 'start';
				x0 = cx;
			} else if (cx + width / 2 > right) {
				anchor = 'end';
				x0 = cx - width;
			}

			// Above first, then below; if neither fits the label is simply dropped.
			for (const dy of [-11, 17]) {
				const baseline = cy + dy;
				if (baseline - LABEL_HEIGHT < PAD.top || baseline > HEIGHT - PAD.bottom) continue;
				const box = {
					x0,
					x1: x0 + width,
					y0: baseline - LABEL_HEIGHT,
					y1: baseline + 2
				};
				if (overlaps(box)) continue;
				boxes.push(box);
				placed.push({ id: point.id, text: point.label, x: cx, y: baseline, anchor });
				break;
			}
		}
		return placed;
	});

	let tooltipStyle = $derived.by(() => {
		if (!hovered) return '';
		const x = scaleX(hovered.x);
		const y = scaleY(hovered.y);
		// Flip the tooltip to the left near the right edge so it never overflows.
		const flip = x > WIDTH * 0.62;
		return `left:${((flip ? x - 12 : x + 12) / WIDTH) * 100}%;top:${(y / HEIGHT) * 100}%;transform:translate(${flip ? '-100%' : '0'},-50%)`;
	});
</script>

<div class="wrapper">
	<svg viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="{yLabel} against {xLabel}">
		{#each yTicks as tick (tick)}
			<line
				class="grid-line"
				x1={PAD.left}
				x2={WIDTH - PAD.right}
				y1={scaleY(tick)}
				y2={scaleY(tick)}
			/>
			<text class="axis-text" x={PAD.left - 8} y={scaleY(tick)} text-anchor="end" dy="0.32em">
				{formatY(tick)}
			</text>
		{/each}

		<line
			class="axis-line"
			x1={PAD.left}
			x2={WIDTH - PAD.right}
			y1={HEIGHT - PAD.bottom}
			y2={HEIGHT - PAD.bottom}
		/>

		{#each xTicks as tick (tick)}
			<text class="axis-text" x={scaleX(tick)} y={HEIGHT - PAD.bottom + 16} text-anchor="middle">
				{formatX(tick)}
			</text>
		{/each}

		<text class="axis-text" x={WIDTH / 2} y={HEIGHT - 6} text-anchor="middle">
			{xLabel}{useLog ? ' (log scale)' : ''}
		</text>
		<text class="axis-text" x={-(HEIGHT / 2)} y={14} text-anchor="middle" transform="rotate(-90)"
			>{yLabel}</text
		>

		{#if frontierPath}
			<path class="frontier" d={frontierPath} />
		{/if}

		{#each points as point (point.id)}
			<!-- Hit target is deliberately larger than the mark: an 8px dot you must
			     land on dead-centre is not a hover target. -->
			<circle
				class="hit"
				cx={scaleX(point.x)}
				cy={scaleY(point.y)}
				r="14"
				onmouseenter={() => (hovered = point)}
				onmouseleave={() => (hovered = null)}
				onclick={() => onselect?.(point.id)}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') onselect?.(point.id);
				}}
				onfocus={() => (hovered = point)}
				onblur={() => (hovered = null)}
				role="button"
				tabindex="0"
				aria-label="{point.label}: {formatY(point.y)} at {formatX(point.x)}"
			/>
			<circle
				class="dot"
				class:on-frontier={point.frontier}
				class:active={hovered?.id === point.id}
				cx={scaleX(point.x)}
				cy={scaleY(point.y)}
				r={point.frontier ? 5.5 : 4.5}
			/>
		{/each}

		<!-- Direct labels only on the frontier, and only where one fits without
		     colliding: a label on every point is chaos, and a stacked or clipped
		     label is worse than none. The table view carries every row. -->
		{#each placedLabels as label (label.id)}
			<text class="point-label" x={label.x} y={label.y} text-anchor={label.anchor}>
				{label.text}
			</text>
		{/each}
	</svg>

	{#if hovered}
		<div class="tooltip" style={tooltipStyle}>
			<div class="tip-title">{hovered.label}</div>
			<div class="tip-row">{yLabel}: <strong>{formatY(hovered.y)}</strong></div>
			<div class="tip-row">{xLabel}: <strong>{formatX(hovered.x)}</strong></div>
			<div class="tip-row muted">n = {hovered.n}{hovered.frontier ? ' · on frontier' : ''}</div>
			{#if hovered.detail}<div class="tip-row muted">{hovered.detail}</div>{/if}
		</div>
	{/if}

	{#if points.length === 0}
		<p class="empty muted">No runs in this slice report both {xLabel} and {yLabel}. {UNKNOWN}</p>
	{/if}
</div>

<style>
	.wrapper {
		position: relative;
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.dot {
		fill: var(--series-1);
		fill-opacity: 0.45;
		/* 2px surface ring keeps overlapping points legible. */
		stroke: var(--surface-1);
		stroke-width: 2;
	}

	.dot.on-frontier {
		fill-opacity: 1;
	}

	.dot.active {
		fill-opacity: 1;
		stroke: var(--text-primary);
	}

	.hit {
		fill: transparent;
		cursor: pointer;
	}

	.hit:focus-visible {
		outline: 2px solid var(--series-1);
		outline-offset: 2px;
	}

	.frontier {
		fill: none;
		stroke: var(--series-1);
		stroke-width: 2;
		stroke-opacity: 0.4;
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.point-label {
		fill: var(--text-secondary);
		font-size: 10px;
		font-family: var(--sans);
		paint-order: stroke;
		stroke: var(--surface-1);
		stroke-width: 3px;
	}

	.tooltip {
		position: absolute;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 9px;
		font-size: 12px;
		pointer-events: none;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
		white-space: nowrap;
		z-index: 2;
	}

	.tip-title {
		font-weight: 600;
		margin-bottom: 2px;
	}

	.tip-row {
		color: var(--text-secondary);
	}

	.empty {
		text-align: center;
		padding: 12px;
	}
</style>
