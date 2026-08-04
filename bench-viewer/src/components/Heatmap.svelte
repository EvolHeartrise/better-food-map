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

<div class="scroll-x">
	<table class="heat">
		<thead>
			<tr>
				<th class="left">Configuration</th>
				{#each columns as column (column)}
					<th>{column}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.key)}
				<tr>
					<td class="left rowlabel" title={row.key}>
						{row.label}
						{#if row.note}<span class="muted"> · {row.note}</span>{/if}
					</td>
					{#each columns as column (column)}
						{@const cell = value(row.key, column)}
						{#if cell && cell.value !== null}
							<td class="cell">
								<button
									class="swatch"
									style="background:{fill(cell.value)};color:{ink(cell.value)}"
									title="{row.label} · {column} · n={cell.n}"
									onclick={() => onselect?.(row.key, column)}
								>
									{format(cell.value)}
									{#if cell.n > 1}<span class="n">n{cell.n}</span>{/if}
								</button>
							</td>
						{:else if cell}
							<!-- Ran, but produced no score. A DIFFERENT fact from "never ran",
							     and one this grid used to label as "never run". -->
							<td class="cell">
								<span
									class="absent"
									title="Ran {cell.n} time(s), {cell.failed} failed — no score produced"
									>{UNKNOWN}<span class="ran">!</span></span
								>
							</td>
						{:else}
							<td class="cell"><span class="absent" title="never run">{UNKNOWN}</span></td>
						{/if}
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="legend row">
	<span class="muted">{format(observed.lo)}</span>
	{#each STEPS as step (step)}
		<span class="key" style="background:{step}"></span>
	{/each}
	<span class="muted">{format(observed.hi)}</span>
	<span class="muted legend-note">scale spans the observed range, not 0–100%</span>
</div>

<style>
	.heat td,
	.heat th {
		border-bottom: none;
		padding: 3px;
	}

	.heat thead th {
		padding: 4px 6px;
		border-bottom: 1px solid var(--axis);
	}

	.rowlabel {
		font-size: 12px;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cell {
		text-align: center;
	}

	.swatch {
		display: block;
		width: 100%;
		min-width: 78px;
		border: none;
		/* 2px surface gap between fills — white does the separating, not a stroke. */
		outline: 2px solid var(--surface-1);
		border-radius: 4px;
		padding: 5px 6px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}

	.swatch:hover {
		outline-color: var(--text-primary);
	}

	.n {
		opacity: 0.75;
		font-size: 10px;
		margin-left: 4px;
	}

	.absent {
		color: var(--text-muted);
		font-size: 12px;
	}

	/* Marks "ran but produced no score" apart from "never ran" without colour. */
	.ran {
		color: var(--critical);
		font-weight: 700;
		margin-left: 2px;
	}

	.legend {
		margin-top: 10px;
		font-size: 11px;
	}

	.key {
		width: 26px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
	}

	.legend-note {
		margin-left: 8px;
	}
</style>
