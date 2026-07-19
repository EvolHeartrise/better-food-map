/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import { compareRow, decideMenu, type FetchOutcome, type WatchRow } from './decide';

function row(over: Partial<WatchRow> = {}): WatchRow {
	return {
		url: 'https://cafe.example/menu',
		kind: 'html',
		content_hash: 'text:aaa',
		signal_hash: 'signal:sss',
		etag: null,
		last_modified: null,
		fetch_status: 'ok',
		...over
	};
}

function outcome(over: Partial<FetchOutcome> = {}): FetchOutcome {
	return {
		url: 'https://cafe.example/menu',
		fetch_status: 'ok',
		content_hash: 'text:aaa',
		signal_hash: 'signal:sss',
		etag: null,
		last_modified: null,
		...over
	};
}

// ---------------------------------------------------------------------------
// compareRow
// ---------------------------------------------------------------------------

test('compareRow: identical hashes are stable', () => {
	expect(compareRow(row(), outcome())).toBe('stable');
});

test('compareRow: 304 settles a row without hashes', () => {
	expect(
		compareRow(row(), outcome({ not_modified: true, content_hash: null, signal_hash: null }))
	).toBe('stable');
});

test('compareRow: html prefers the price signal — banner churn is stable, repricing is not', () => {
	// full text changed (banner), price signal identical → stable
	expect(compareRow(row(), outcome({ content_hash: 'text:bbb' }))).toBe('stable');
	// price signal changed → changed, regardless of content hash
	expect(compareRow(row(), outcome({ signal_hash: 'signal:ttt' }))).toBe('changed');
});

test('compareRow: a side losing its price signal falls back to strict content comparison', () => {
	expect(compareRow(row({ signal_hash: null }), outcome({ content_hash: 'text:bbb' }))).toBe(
		'changed'
	);
	expect(compareRow(row(), outcome({ signal_hash: null, content_hash: 'text:bbb' }))).toBe(
		'changed'
	);
	expect(compareRow(row(), outcome({ signal_hash: null }))).toBe('stable');
});

test('compareRow: feed and pdf always compare content, never signal', () => {
	expect(
		compareRow(
			row({ kind: 'feed', content_hash: 'feed:aaa' }),
			outcome({ content_hash: 'feed:aaa', signal_hash: 'signal:different' })
		)
	).toBe('stable');
	expect(
		compareRow(
			row({ kind: 'pdf', content_hash: 'text:aaa' }),
			outcome({ content_hash: 'text:bbb' })
		)
	).toBe('changed');
});

test('compareRow: pipeline prefix mismatch reads as changed (fails open)', () => {
	// pdftotext-less environment produced bytes: against a text: baseline
	expect(
		compareRow(
			row({ kind: 'pdf', content_hash: 'text:aaa' }),
			outcome({ content_hash: 'bytes:aaa' })
		)
	).toBe('changed');
});

test('compareRow: baseline that never hashed → no_baseline; failing fetch now → unfetchable', () => {
	expect(compareRow(row({ fetch_status: 'blocked', content_hash: null }), outcome())).toBe(
		'no_baseline'
	);
	expect(compareRow(row(), outcome({ fetch_status: 'http_error', content_hash: null }))).toBe(
		'unfetchable'
	);
	expect(compareRow(row(), outcome({ fetch_status: 'degenerate', content_hash: null }))).toBe(
		'unfetchable'
	);
});

// ---------------------------------------------------------------------------
// decideMenu
// ---------------------------------------------------------------------------

const asMap = (outcomes: FetchOutcome[]) => new Map(outcomes.map((o) => [o.url, o]));

test('decideMenu: no rows → no_fingerprints', () => {
	expect(decideMenu([], asMap([]))).toEqual({
		verdict: 'needs_refresh',
		reason: 'no_fingerprints'
	});
});

test('decideMenu: all rows stable → unchanged', () => {
	const rows = [row(), row({ url: 'https://cafe.example/drinks', content_hash: 'text:ddd' })];
	const outcomes = [
		outcome(),
		outcome({ url: 'https://cafe.example/drinks', content_hash: 'text:ddd' })
	];
	expect(decideMenu(rows, asMap(outcomes))).toEqual({ verdict: 'unchanged' });
});

test('decideMenu: one changed row flags the menu, changed outranks other reasons', () => {
	const rows = [row(), row({ url: 'https://cafe.example/drinks', fetch_status: 'blocked' })];
	const outcomes = [outcome({ signal_hash: 'signal:changed' })];
	const d = decideMenu(rows, asMap(outcomes));
	expect(d.verdict).toBe('needs_refresh');
	expect(d.reason).toBe('changed');
	expect(d.urls).toEqual(['https://cafe.example/menu']);
});

test('decideMenu: a row with no fetch outcome counts as unfetchable', () => {
	const d = decideMenu([row()], asMap([]));
	expect(d).toEqual({
		verdict: 'needs_refresh',
		reason: 'fetch_failed',
		urls: ['https://cafe.example/menu']
	});
});

test('decideMenu: STRICT — one baseline-less row forces the agent path even when others are stable', () => {
	// e.g. bot-walled aggregator recorded at baseline next to a healthy feed:
	// the walled page could be the primary surface, so no auto-skip.
	const rows = [
		row({ url: 'https://feed.example/api', kind: 'feed', content_hash: 'feed:fff' }),
		row({ url: 'https://walled.example/menu', fetch_status: 'blocked', content_hash: null })
	];
	const outcomes = [
		outcome({ url: 'https://feed.example/api', content_hash: 'feed:fff', signal_hash: null }),
		outcome({ url: 'https://walled.example/menu', fetch_status: 'blocked', content_hash: null })
	];
	const d = decideMenu(rows, asMap(outcomes));
	expect(d.verdict).toBe('needs_refresh');
	expect(d.reason).toBe('no_baseline_hash');
	expect(d.urls).toEqual(['https://walled.example/menu']);
});
