// ---------------------------------------------------------------------------
// Source-citation input schema shared by the MCP server's create_*/update_*
// tools. Accepts either the canonical { url, label? } object or a bare URL
// string (normalized to { url, label: null } at parse time): agents
// overwhelmingly hold plain URL lists, and requiring the object wrapper was a
// recurring remap step — and a recurring source of invalid-arguments errors.
// Kept in its own module so it is unit-testable (db-mcp-server.ts connects a
// stdio transport on import, so tests must not import it).
// ---------------------------------------------------------------------------

import * as v from 'valibot';

import { safeHttpUrl } from '../../src/lib/safe-url';

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
