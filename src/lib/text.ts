// ---------------------------------------------------------------------------
// Tiny, pure, client-safe string helpers shared across the app and the OSM
// data-pipeline scripts. No node/bun/Worker APIs, so every layer can import the
// SAME normalization primitives (diacritic folding, whitespace collapsing)
// instead of re-implementing them — mirrors `$lib/category.ts` / `$lib/tags.ts`.
// ---------------------------------------------------------------------------

/** Decomposes accented characters and strips combining marks (Québec → Quebec). */
export function stripDiacritics(value: string): string {
	return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Collapses runs of whitespace to a single space and trims both ends. */
export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/** Collapses whitespace and maps an empty/whitespace-only result to null. */
export function blankToNull(value: string | null | undefined): string | null {
	if (!value) return null;
	const collapsed = collapseWhitespace(value);
	return collapsed.length ? collapsed : null;
}
