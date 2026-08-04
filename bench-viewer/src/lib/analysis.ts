/**
 * Client-side derivations that are plain data transforms, not UI.
 *
 * They live outside the components for three reasons: the components stay
 * readable, the collections built here are ordinary Maps/Sets rather than
 * reactive ones (they are constructed fresh per derivation and never mutated
 * afterwards), and the logic is testable without mounting anything.
 *
 * Nothing here re-scores: the server's numbers are canonical. These functions
 * only reshape and compare what it already returned.
 */
import type { CellRow, MenuItem, MetricKey } from './types';

// --- frontier -----------------------------------------------------------------

export interface PlottedCell {
	cell: CellRow;
	x: number;
	y: number;
}

/**
 * Cells that report BOTH axes. A cell missing either is excluded, never plotted
 * at zero — an unreported cost is unknown, not free, and a zero would sit on the
 * frontier and read as the best value on the chart.
 */
export function plottableCells(
	cells: readonly CellRow[],
	xOf: (cell: CellRow) => number | null,
	metric: MetricKey
): PlottedCell[] {
	const out: PlottedCell[] = [];
	for (const cell of cells) {
		const x = xOf(cell);
		const y = cell.metrics[metric].mean;
		if (x === null || y === null || x <= 0) continue;
		out.push({ cell, x, y });
	}
	return out;
}

/** Keys of the non-dominated cells: nothing is both cheaper/faster AND better. */
export function frontierKeys(points: readonly PlottedCell[]): Set<string> {
	const keys = new Set<string>();
	for (const point of points) {
		const dominated = points.some(
			(other) =>
				other !== point &&
				other.x <= point.x &&
				other.y >= point.y &&
				(other.x < point.x || other.y > point.y)
		);
		if (!dominated) keys.add(point.cell.key);
	}
	return keys;
}

// --- heatmap ------------------------------------------------------------------

export interface HeatRow {
	key: string;
	label: string;
	note?: string;
}

/** Config identity WITHOUT the task dimension — one heatmap row per configuration. */
export function configKey(cell: CellRow): string {
	return [cell.model, cell.backend, cell.effort, cell.quantization ?? ''].join(' | ');
}

export function heatRows(cells: readonly CellRow[]): HeatRow[] {
	const seen = new Map<string, HeatRow>();
	for (const cell of cells) {
		const key = configKey(cell);
		if (seen.has(key)) continue;
		seen.set(key, {
			key,
			label: `${cell.model.split('/').pop()} · ${cell.effort}`,
			note: cell.quantization && cell.quantization !== 'unpinned' ? cell.quantization : undefined
		});
	}
	return [...seen.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}

export interface HeatCell {
	value: number | null;
	n: number;
}

/** (config, task) → value lookup for the heatmap. A missing key means never run. */
export function heatLookup(cells: readonly CellRow[], metric: MetricKey): Map<string, HeatCell> {
	const map = new Map<string, HeatCell>();
	for (const cell of cells) {
		map.set(`${configKey(cell)}::${cell.task}`, {
			value: cell.metrics[metric].mean,
			n: cell.n_runs
		});
	}
	return map;
}

// --- run comparison -----------------------------------------------------------

/**
 * The scorer's item-matching key, mirrored client-side: parentheses dropped,
 * curly apostrophes folded, whitespace collapsed, lowercased. Comparing on
 * anything else would surface "differences" the scorer never counted.
 */
export function itemKey(name: string): string {
	return name
		.replace(/\(([^()]*)\)/g, (_match, inner: string) => ` ${inner.replace(/\s+/g, '')} `)
		.replace(/[()]/g, ' ')
		.replace(/[’‘ʼ´`]/g, "'")
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

function indexItems(items: readonly MenuItem[] | null): Map<string, MenuItem> {
	const map = new Map<string, MenuItem>();
	for (const item of items ?? []) {
		const key = itemKey(item.name);
		if (!map.has(key)) map.set(key, item);
	}
	return map;
}

export interface FieldDifference {
	name: string;
	field: string;
	a: string;
	b: string;
}

export interface RunDiff {
	onlyA: MenuItem[];
	onlyB: MenuItem[];
	differing: FieldDifference[];
	goldKeys: Set<string>;
}

/** Item-level diff of two submissions for the same task. */
export function diffRuns(
	candidatesA: readonly MenuItem[] | null,
	candidatesB: readonly MenuItem[] | null,
	goldItems: readonly MenuItem[] | null
): RunDiff {
	const left = indexItems(candidatesA);
	const right = indexItems(candidatesB);
	const goldKeys = new Set(indexItems(goldItems).keys());

	const onlyA: MenuItem[] = [];
	const onlyB: MenuItem[] = [];
	const differing: FieldDifference[] = [];

	for (const [key, item] of left) {
		const other = right.get(key);
		if (!other) {
			onlyA.push(item);
			continue;
		}
		if (item.price !== other.price) {
			differing.push({
				name: item.name,
				field: 'price',
				a: item.price === null ? '(null)' : String(item.price),
				b: other.price === null ? '(null)' : String(other.price)
			});
		}
		const tagsA = item.tags.toSorted().join(', ');
		const tagsB = other.tags.toSorted().join(', ');
		if (tagsA !== tagsB) {
			differing.push({
				name: item.name,
				field: 'tags',
				a: tagsA || '(none)',
				b: tagsB || '(none)'
			});
		}
	}
	for (const [key, item] of right) {
		if (!left.has(key)) onlyB.push(item);
	}

	return { onlyA, onlyB, differing, goldKeys };
}
