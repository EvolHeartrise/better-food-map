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

/** Canonical shape of one source citation, as stored. */
export const sourceObjectSchema = v.object({
	url: v.pipe(
		v.string(),
		v.url('Each source must be a valid URL, e.g. https://example.com/menu.'),
		v.description('URL the data was obtained from.')
	),
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
		v.string(),
		v.url('Each source must be a valid URL, e.g. https://example.com/menu.'),
		v.transform((url) => ({ url, label: null as string | null })),
		v.description('Bare URL string — shorthand for { url } with no label.')
	),
	sourceObjectSchema
]);

/** What one parsed source looks like after validation (strings already folded). */
export type SourceInput = v.InferOutput<typeof sourceInputSchema>;
