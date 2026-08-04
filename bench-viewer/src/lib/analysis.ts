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

/**
 * Config identity WITHOUT the task dimension — one heatmap row per configuration.
 *
 * Includes provenance for the same reason the leaderboard's default grouping
 * does: a score measures model x provider x quantization, so two endpoints must
 * not silently share a row here while the leaderboard keeps them apart.
 */
export function configKey(cell: CellRow): string {
	return [
		cell.model,
		cell.backend,
		cell.effort,
		cell.quantization ?? '',
		cell.provenance ?? ''
	].join('\u0000');
}

export function heatRows(cells: readonly CellRow[]): HeatRow[] {
	const backends = new Set(cells.map((cell) => cell.backend));
	const provenances = new Set(cells.map((cell) => cell.provenance ?? ''));
	const seen = new Map<string, HeatRow>();
	for (const cell of cells) {
		const key = configKey(cell);
		if (seen.has(key)) continue;
		const notes = [
			cell.quantization && cell.quantization !== 'unpinned' ? cell.quantization : null,
			// Only when it varies: naming the backend on every row is noise, but two
			// rows that differ ONLY by backend must not render identically.
			backends.size > 1 ? cell.backend : null,
			provenances.size > 1 ? (cell.provenance ?? null) : null
		].filter(Boolean);
		seen.set(key, {
			key,
			label: `${cell.model.split('/').pop()} · ${cell.effort}`,
			note: notes.length > 0 ? notes.join(' · ') : undefined
		});
	}
	return [...seen.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}

export interface HeatCell {
	/** Null when the cell has runs but none produced a score. */
	value: number | null;
	/** Runs in the cell, including failed ones. */
	n: number;
	/** Runs that failed — a cell with `value: null` and `failed > 0` DID run. */
	failed: number;
}

/**
 * (config, task) → value lookup for the heatmap.
 *
 * An ABSENT key means that configuration never ran that task. A present key with
 * `value: null` means it ran and produced no score — a different fact, and one
 * the grid previously reported as "never run".
 */
export function heatLookup(cells: readonly CellRow[], metric: MetricKey): Map<string, HeatCell> {
	const map = new Map<string, HeatCell>();
	for (const cell of cells) {
		map.set(`${configKey(cell)}::${cell.task}`, {
			value: cell.metrics[metric].mean,
			n: cell.n_runs,
			failed: cell.n_failed
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

function compareList(
	out: FieldDifference[],
	name: string,
	field: string,
	a: readonly string[],
	b: readonly string[]
): void {
	const left = a.toSorted().join(', ');
	const right = b.toSorted().join(', ');
	if (left !== right) out.push({ name, field, a: left || '(none)', b: right || '(none)' });
}

/** The scorer compares descriptions after the same normalization. */
function normalizeText(value: string | null): string {
	return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
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
		compareList(differing, item.name, 'tags', item.tags, other.tags);
		compareList(differing, item.name, 'optional_tags', item.optional_tags, other.optional_tags);
		// description and warning are scored metrics too; a diff that silently
		// skipped them showed "0 differences" for runs whose description accuracy
		// differed by 14 points.
		if (normalizeText(item.description) !== normalizeText(other.description)) {
			differing.push({
				name: item.name,
				field: 'description',
				a: item.description ?? '(null)',
				b: other.description ?? '(null)'
			});
		}
		const warnA = typeof item.warning === 'string';
		const warnB = typeof other.warning === 'string';
		if (warnA !== warnB) {
			differing.push({
				name: item.name,
				field: 'warning',
				a: warnA ? 'flagged' : 'none',
				b: warnB ? 'flagged' : 'none'
			});
		}
	}
	for (const [key, item] of right) {
		if (!left.has(key)) onlyB.push(item);
	}

	return { onlyA, onlyB, differing, goldKeys };
}
