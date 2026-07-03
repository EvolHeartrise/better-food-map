// A tool handler that commits work in stages (e.g. import_chain's chunked D1
// batches) must not let a mid-run throw erase what already landed: the plain
// error string would hide the imported count, the skipped lists and — worst —
// the insert-time near-duplicate warnings, which a dedup-safe re-run can never
// resurface (re-imported branches report as excluded_existing). Throwing this
// error instead lets the MCP layer reply with isError (the failure stays
// unmissable) while the body carries the committed partial state.
export class ToolPartialFailure extends Error {
	readonly partial: Record<string, unknown>;

	constructor(message: string, partial: Record<string, unknown>) {
		super(message);
		this.name = 'ToolPartialFailure';
		this.partial = partial;
	}
}

/**
 * The MCP text body for a partial failure: `error` and `partial_failure` lead
 * so an agent skimming the JSON cannot mistake it for a complete result, then
 * the accumulated per-stage fields (imported counts, warnings, skipped lists).
 */
export function partialFailureBody(err: ToolPartialFailure): string {
	const partial = Object.fromEntries(
		Object.entries(err.partial).filter(([k]) => k !== 'error' && k !== 'partial_failure')
	);
	return JSON.stringify({ error: err.message, partial_failure: true, ...partial });
}
