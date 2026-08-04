/**
 * Display formatting.
 *
 * The single rule enforced here: an unknown value renders as an em dash, never
 * as `0`, `0%` or `$0.00`. The index is full of legitimately-absent fields (a
 * cost the provider never reported, a wall-clock predating the field), and a
 * dashboard that shows those as zero is lying about the corpus.
 */

export const UNKNOWN = '—';

export function pct(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
	return `${(value * 100).toFixed(digits)}%`;
}

/** Cost in USD. Sub-cent runs are the norm here, so show enough digits to compare. */
export function usd(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
	if (value === 0) return '$0';
	if (value < 0.01) return `$${value.toFixed(5)}`;
	if (value < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 90) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function count(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
	return value.toLocaleString('en-US');
}

export function decimal(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
	return value.toFixed(digits);
}

/** `2026-08-04 19:40` — local-agnostic, sortable, no seconds noise. */
export function timestamp(iso: string | null | undefined): string {
	if (!iso) return UNKNOWN;
	return iso.replace('T', ' ').slice(0, 16);
}

/** Short model label: strip the provider prefix, which the column groups by anyway. */
export function shortModel(model: string): string {
	const slash = model.indexOf('/');
	return slash === -1 ? model : model.slice(slash + 1);
}

/** Human metric names — the report's keys read as code, not as columns. */
export const METRIC_LABELS: Record<string, string> = {
	item_recall: 'Item recall',
	item_precision: 'Item prec.',
	tag_precision: 'Tag prec.',
	tag_recall: 'Tag recall',
	optional_tag_precision: 'Opt-tag prec.',
	optional_tag_recall: 'Opt-tag recall',
	price_accuracy: 'Price acc.',
	description_accuracy: 'Desc. acc.',
	warning_accuracy: 'Warning acc.',
	source_recall: 'Source recall',
	source_precision: 'Source prec.'
};

export function metricLabel(key: string): string {
	return METRIC_LABELS[key] ?? key;
}
