// ---------------------------------------------------------------------------
// Source-citation input schema shared by the MCP server's create_*/update_*
// tools. Accepts either the canonical { url, label? } object or a bare URL
// string (normalized to { url, label: null } at parse time): agents
// overwhelmingly hold plain URL lists, and requiring the object wrapper was a
// recurring remap step — and a recurring source of invalid-arguments errors.
// Split out of the large db-mcp-server.ts into a focused, directly unit-testable
// module.
// ---------------------------------------------------------------------------

import * as v from 'valibot';

import { safeHttpUrl } from '../../src/lib/safe-url';
import type { Source } from '../../src/lib/server/db';

/**
 * The kinds of link a menu's sources should cite, woven into both the tool
 * description strings and the {@link assertHasSource} error. Sources are
 * menu-level provenance a human reads to trust the food data.
 */
export const SOURCE_KINDS_HINT =
	'the menu / online-ordering link, an official nutrition page, an official dietary/allergen page';

/** Normalizes optional source labels to null so they match the DB `Source` type. */
export function normalizeSources(
	sources: { url: string; label?: string | null }[] | undefined
): Source[] | undefined {
	return sources?.map((s) => ({ url: s.url, label: s.label ?? null }));
}

/**
 * Enforces the menu-provenance rule: a menu must cite AT LEAST ONE source link
 * (sources are menu-level, so this is where "the food data must be verifiable"
 * is enforced). `label` names the record in the error. Throws when `sources` is
 * missing or empty.
 */
export function assertHasSource(sources: { url: string }[] | undefined, label: string): void {
	if (!sources || sources.length === 0) {
		throw new Error(
			`${label}: at least one source link is required — cite where this menu's food data came from ` +
				`(${SOURCE_KINDS_HINT}). Sources are menu-level; every menu must be verifiable.`
		);
	}
}

// valibot's v.url() accepts anything `new URL()` parses — including
// `javascript:alert(1)` — and source URLs are rendered as anchor hrefs in the
// placecard, so ingestion additionally requires an http(s) scheme (the render
// side has its own allowlist covering rows already stored).
const SOURCE_URL_MESSAGE = 'Each source must be an http(s) URL, e.g. https://example.com/menu.';
const sourceUrlPipe = () =>
	v.pipe(
		v.string(),
		v.url(SOURCE_URL_MESSAGE),
		v.check((url) => safeHttpUrl(url) !== null, SOURCE_URL_MESSAGE)
	);

/** Canonical shape of one source citation, as stored. */
export const sourceObjectSchema = v.object({
	url: v.pipe(sourceUrlPipe(), v.description('URL the data was obtained from.')),
	label: v.optional(
		v.nullable(
			v.pipe(v.string(), v.description("Optional human-readable label, e.g. 'Official menu'."))
		)
	)
});

/**
 * One source as the tools ACCEPT it: a bare URL string (shorthand) or the full
 * { url, label } object. A string parses to { url, label: null }, so handlers
 * downstream always see the object shape.
 */
export const sourceInputSchema = v.union([
	v.pipe(
		sourceUrlPipe(),
		v.transform((url) => ({ url, label: null as string | null })),
		v.description('Bare URL string — shorthand for { url } with no label.')
	),
	sourceObjectSchema
]);

/** What one parsed source looks like after validation (strings already folded). */
export type SourceInput = v.InferOutput<typeof sourceInputSchema>;
