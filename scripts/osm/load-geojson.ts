// ---------------------------------------------------------------------------
// Parses an `osmium export -f geojsonseq` stream (one GeoJSON feature per line,
// optionally RFC 8142 record-separator prefixed) into POI rows and loads them
// into the staging store. Kept independent of osmium so it is unit-testable from
// a fixture (load-geojson.test.ts) without the external binary.
// ---------------------------------------------------------------------------

import { mapFeature, type OsmFeature, type PoiRow } from './map-feature';
import type { OsmPoiStore } from './poi-store';

/**
 * Parses one geojsonseq line into a {@link PoiRow}, or null when the line is
 * blank, unparseable, or not a recognised food POI. Never throws — a single bad
 * line should not abort a multi-hundred-thousand-feature load.
 *
 * Leading control chars (code point < 0x20: whitespace and the RFC 8142 record
 * separator U+001E that geojsonseq prefixes each feature with) are skipped first.
 */
export function parseFeatureLine(line: string): PoiRow | null {
	let start = 0;
	while (start < line.length && line.charCodeAt(start) < 0x20) start++;
	const trimmed = line.slice(start).trim();
	if (!trimmed) return null;
	let feature: OsmFeature;
	try {
		feature = JSON.parse(trimmed) as OsmFeature;
	} catch {
		return null;
	}
	return mapFeature(feature);
}

export interface LoadResult {
	/** Food POIs inserted. */
	inserted: number;
	/** Lines skipped (blank, unparseable, or not a food POI). */
	skipped: number;
}

/**
 * Loads geojsonseq `lines` into `store` under `region`, REPLACING any existing
 * rows for that region. Rows are mapped first, then written in one transaction.
 */
export function loadLines(store: OsmPoiStore, region: string, lines: Iterable<string>): LoadResult {
	const rows: PoiRow[] = [];
	let skipped = 0;
	for (const line of lines) {
		const row = parseFeatureLine(line);
		if (row) rows.push(row);
		else if (line.trim()) skipped++; // blank lines are not "skips"
	}
	const inserted = store.replaceRegion(region, rows);
	return { inserted, skipped };
}
