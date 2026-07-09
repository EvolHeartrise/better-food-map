// Tests ToolPartialFailure — the carrier import_chain uses when a chunked D1
// import dies mid-run (issue #90): the committed chunks' results (imported
// count, warnings, skipped lists) must survive into the error reply instead of
// being replaced by a bare error string.

import { test, expect } from 'bun:test';
import { ToolPartialFailure, partialFailureBody } from './partial-failure';

test('is an Error and remains detectable via instanceof', () => {
	const err = new ToolPartialFailure('D1 500 on chunk 3', { imported: 100 });
	expect(err).toBeInstanceOf(Error);
	expect(err).toBeInstanceOf(ToolPartialFailure);
	expect(err.name).toBe('ToolPartialFailure');
	expect(err.message).toBe('D1 500 on chunk 3');
});

test('body leads with error + partial_failure, then the committed state', () => {
	const err = new ToolPartialFailure('D1 500 on chunk 3', {
		imported: 100,
		warnings: ['"Subway" at 12 m from existing loc_a'],
		remaining_beyond_max: 57
	});
	const body = JSON.parse(partialFailureBody(err));
	expect(body).toEqual({
		error: 'D1 500 on chunk 3',
		partial_failure: true,
		imported: 100,
		warnings: ['"Subway" at 12 m from existing loc_a'],
		remaining_beyond_max: 57
	});
	// The failure marker must come first so a skimming agent can't read the
	// reply as a complete result.
	expect(Object.keys(body)[0]).toBe('error');
	expect(Object.keys(body)[1]).toBe('partial_failure');
});

test('partial state cannot shadow the failure markers', () => {
	const err = new ToolPartialFailure('boom', {
		error: 'not-the-real-error',
		partial_failure: false,
		imported: 1
	});
	const body = JSON.parse(partialFailureBody(err));
	expect(body).toEqual({ error: 'boom', partial_failure: true, imported: 1 });
});
