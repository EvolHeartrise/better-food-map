<script lang="ts">
	/**
	 * Model × task grid for one metric.
	 *
	 * Sequential single-hue ramp (light → dark = worse → better), never a rainbow.
	 * Every cell also carries its printed value, so colour is a scanning aid
	 * rather than the only encoding — the grid doubles as its own table view.
	 *
	 * Three distinct empty states, because collapsing them tells lies: a value,
	 * a dash (never ran), and a dash with "!" (ran, produced no score). None of
	 * them is a zero.
	 *
	 * A plain <table>, not the shadcn data table: this grid is a chart, and row
	 * borders/hover tints would fight the fills that carry its meaning.
	 */
	import { UNKNOWN } from '../lib/format';

	let {
		rows,
		columns,
		value,
		format,
		onselect
	}: {
		rows: { key: string; label: string; note?: string }[];
		columns: string[];
		value: (
			rowKey: string,
			column: string
		) => { value: number | null; n: number; failed: number } | null;
		format: (value: number) => string;
		onselect?: (rowKey: string, column: string) => void;
	} = $props();

	/**
	 * Ramp steps for the *observed* band rather than 0–1: menu-extraction scores
	 * cluster in the 0.8–1.0 range, so a full-range ramp would paint every cell
	 * the same dark step and show nothing.
	 */
	const STEPS = [
		'var(--seq-100)',
		'var(--seq-200)',
		'var(--seq-300)',
		'var(--seq-400)',
		'var(--seq-500)',
		'var(--seq-600)'
	];

	let observed = $derived.by(() => {
		const values: number[] = [];
		for (const row of rows) {
			for (const column of columns) {
				const cell = value(row.key, column);
				if (cell?.value !== null && cell?.value !== undefined) values.push(cell.value);
			}
		}
		if (values.length === 0) return { lo: 0, hi: 1 };
		const lo = Math.min(...values);
		const hi = Math.max(...values);
		return lo === hi ? { lo: lo - 0.01, hi } : { lo, hi };
	});

	function stepIndex(cellValue: number): number {
		const t = (cellValue - observed.lo) / (observed.hi - observed.lo || 1);
		return Math.min(STEPS.length - 1, Math.max(0, Math.round(t * (STEPS.length - 1))));
	}

	function fill(cellValue: number): string {
		return STEPS[stepIndex(cellValue)];
	}

	/**
	 * Ink that clears contrast on its own fill. Keyed to the SAME bin index the
	 * fill uses, not to a separate threshold: a `t > 0.6` cut put white text on
	 * step 4 (#3987e5) at 3.64:1, under the 4.5:1 AA floor for this size, while
	 * the identical fill elsewhere got black. White is correct from step 4 of 0-5
	 * (5.39:1 on #256abf and darker); black wins below it (5.41:1 on #3987e5).
	 */
	function ink(cellValue: number): string {
		return stepIndex(cellValue) >= 4 ? '#ffffff' : '#0b0b0b';
	}
</script>

<div class="max-w-full overflow-x-auto">
	<table class="w-full border-collapse tabular-nums">
		<thead>
			<tr>
				<th
					class="border-b border-axis px-1.5 py-1 text-left text-xs font-semibold text-muted-foreground"
					>Configuration</th
				>
				{#each columns as column (column)}
					<th
						class="border-b border-axis px-1.5 py-1 text-right text-xs font-semibold text-muted-foreground"
						>{column}</th
					>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.key)}
				<tr>
					<td class="max-w-[320px] truncate p-[3px] text-left text-xs" title={row.key}>
						{row.label}
						{#if row.note}<span class="text-muted-foreground"> · {row.note}</span>{/if}
					</td>
					{#each columns as column (column)}
						{@const cell = value(row.key, column)}
						{#if cell && cell.value !== null}
							<td class="p-[3px] text-center">
								<!-- 2px surface gap between fills — the surface does the separating,
								     not a stroke. -->
								<button
									class="block w-full min-w-[78px] cursor-pointer rounded px-1.5 py-[5px] text-xs outline-2 outline-card hover:outline-foreground focus-visible:outline-foreground"
									style="background:{fill(cell.value)};color:{ink(cell.value)}"
									title="{row.label} · {column} · n={cell.n}"
									onclick={() => onselect?.(row.key, column)}
								>
									{format(cell.value)}
									{#if cell.n > 1}<span class="ml-1 text-[10px] opacity-75">n{cell.n}</span>{/if}
								</button>
							</td>
						{:else if cell}
							<!-- Ran, but produced no score. A DIFFERENT fact from "never ran",
							     and one this grid used to label as "never run". -->
							<td class="p-[3px] text-center">
								<span
									class="text-xs text-muted-foreground"
									title="Ran {cell.n} time(s), {cell.failed} failed — no score produced"
									>{UNKNOWN}<span class="ml-0.5 font-bold text-critical">!</span></span
								>
							</td>
						{:else}
							<td class="p-[3px] text-center">
								<span class="text-xs text-muted-foreground" title="never run">{UNKNOWN}</span>
							</td>
						{/if}
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="mt-2.5 flex items-center gap-2 text-[11px]">
	<span class="text-muted-foreground">{format(observed.lo)}</span>
	{#each STEPS as step (step)}
		<span class="inline-block h-2.5 w-[26px] rounded-sm" style="background:{step}"></span>
	{/each}
	<span class="text-muted-foreground">{format(observed.hi)}</span>
	<span class="ml-2 text-muted-foreground">scale spans the observed range, not 0–100%</span>
</div>
