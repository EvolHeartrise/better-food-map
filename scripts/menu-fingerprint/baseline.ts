// Baseline writer for the menu-source change gate: fingerprint a menu's
// source pages RIGHT AFTER an agent refresh, so the next check.ts run can
// prove "unchanged" against them.
//
//   bun run menu:baseline <menu_id> [<menu_id> …]
//   bun run menu:baseline <menu_id> --urls <url> [<url> …]
//
// Without --urls the watch set derives from the menu's banked knowledge:
// menu_sources urls + every url in refresh_notes (which the refresh workflow
// keeps as the COMPLETE page inventory + feed endpoints), socials/map links
// dropped. --urls (single menu only) overrides the derivation entirely — the
// curation lever for menus whose notes cite pages that can never fingerprint
// (e.g. a bot-walled aggregator next to a perfectly good feed): decide.ts is
// strict, so ONE permanently blocked row keeps the whole menu on the agent
// path until it's curated out.
//
// Each url is fetched once and classified by response content-type
// (json → feed, pdf → pdf, else html). An html page that comes back
// bot-walled, too thin to be real, OR carrying no price signal is retried
// through headless Chromium and promoted to kind 'rendered' when the post-JS
// text is usable — the no-signal case is load-bearing: a client-rendered or
// iframe menu leaves the raw HTML as a nav/footer shell whose visible text is
// plausibly long yet never changes when the menu does, so trusting it would
// bake in a permanent false "unchanged". Rows that still fail are recorded
// with their failure status — visible, and keeping the menu on the agent path
// (fail open).
//
// The write REPLACES the menu's previous watch set atomically.

import type { FetchOutcome } from './decide';
import {
	classifyKind,
	fingerprintUrl,
	outcomeFromBytes,
	rawFetch,
	RenderedFetcher
} from './fetcher';
import { menuMeta, openDb, replaceWatchRows, type BaselineRow } from './db';
import { deriveWatchUrls, MAX_WATCH_URLS, sanitizeUrls } from './urls';

function statusForHttp(status: number): 'blocked' | 'http_error' {
	return status === 403 || status === 429 || status === 503 ? 'blocked' : 'http_error';
}

/**
 * An html row is only trusted as-is when it fetched clean AND shows a price
 * signal. No signal on a 200 page is the SPA-shell/iframe tell (menu arrives
 * post-JS; the shell text hashes stable forever) — those retry via Chromium.
 * Exported for tests.
 */
export function needsRenderedPromotion(row: BaselineRow): boolean {
	return row.kind === 'html' && (row.fetch_status !== 'ok' || row.signal_hash === null);
}

async function baselineUrl(url: string, rendered: RenderedFetcher): Promise<BaselineRow> {
	const raw = await rawFetch(url);
	let row: BaselineRow;
	if (raw === null) {
		row = emptyRow(url, 'http_error');
	} else if (raw.status < 200 || raw.status >= 300) {
		row = emptyRow(url, statusForHttp(raw.status));
	} else {
		const kind = classifyKind(raw.contentType, raw.bytes);
		const outcome = await outcomeFromBytes({ url, kind, etag: null, last_modified: null }, raw);
		row = fromOutcome(url, kind, outcome);
	}
	if (needsRenderedPromotion(row)) {
		const viaChromium = await fingerprintUrl(
			{ url, kind: 'rendered', etag: null, last_modified: null },
			rendered
		);
		// The rendered text (all frames) is a superset of the raw shell, so an
		// ok rendered row always dominates — even without a price signal it at
		// least hashes the content the raw HTML can't see.
		if (viaChromium.fetch_status === 'ok') return fromOutcome(url, 'rendered', viaChromium);
		if (row.fetch_status === 'ok') {
			console.error(
				`    warning: ${url} shows no price signal and Chromium retry failed ` +
					`(${viaChromium.fetch_status}) — if this menu is JS/iframe-rendered, its html ` +
					`fingerprint may not cover it; curate with --urls if so`
			);
		}
	}
	return row;
}

function emptyRow(url: string, fetch_status: BaselineRow['fetch_status']): BaselineRow {
	return {
		url,
		kind: 'html',
		content_hash: null,
		signal_hash: null,
		etag: null,
		last_modified: null,
		fetch_status
	};
}

function fromOutcome(url: string, kind: BaselineRow['kind'], o: FetchOutcome): BaselineRow {
	return {
		url,
		kind,
		content_hash: o.content_hash,
		signal_hash: o.signal_hash,
		etag: o.etag,
		last_modified: o.last_modified,
		fetch_status: o.fetch_status
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const urlsFlag = args.indexOf('--urls');
	const menuIds = urlsFlag === -1 ? args : args.slice(0, urlsFlag);
	// Unknown flags error out rather than being filtered: silently dropping
	// `--limit` would leave its VALUE parsed as a menu id.
	const strayFlag = menuIds.find((a) => a.startsWith('--'));
	if (strayFlag || menuIds.length === 0) {
		if (strayFlag) console.error(`unknown flag ${strayFlag} (only --urls is supported)`);
		console.error('usage: bun run menu:baseline <menu_id> [<menu_id> …] [--urls <url> …]');
		process.exit(1);
	}
	const rawUrls = urlsFlag === -1 ? null : args.slice(urlsFlag + 1);
	const explicitUrls = rawUrls === null ? null : sanitizeUrls(rawUrls);
	if (rawUrls !== null && (menuIds.length !== 1 || rawUrls.length === 0)) {
		console.error('--urls needs exactly one menu_id and at least one url');
		process.exit(1);
	}
	if (explicitUrls !== null && explicitUrls.length < (rawUrls?.length ?? 0)) {
		console.error(
			`note: ${(rawUrls?.length ?? 0) - explicitUrls.length} of the given urls dropped ` +
				`(invalid/duplicate/over the ${MAX_WATCH_URLS}-url cap)`
		);
	}
	if (explicitUrls !== null && explicitUrls.length === 0) {
		console.error('--urls: none of the given urls are valid http(s) urls');
		process.exit(1);
	}

	const db = openDb();
	const today = new Date().toISOString().slice(0, 10);
	const rendered = new RenderedFetcher();
	let failures = 0;
	try {
		for (const menuId of menuIds) {
			const meta = await menuMeta(db, menuId);
			if (!meta) {
				console.error(`✗ no menu with id "${menuId}"`);
				failures++;
				continue;
			}
			const urls = explicitUrls ?? deriveWatchUrls(meta.source_urls, meta.refresh_notes);
			if (urls.length === 0) {
				console.error(`✗ ${meta.name}: no watchable urls (no sources, no urls in refresh_notes)`);
				failures++;
				continue;
			}
			if (urls.length === MAX_WATCH_URLS) {
				console.error(`  ${meta.name}: watch set capped at ${MAX_WATCH_URLS} urls`);
			}
			const rows: BaselineRow[] = [];
			for (const url of urls) {
				rows.push(await baselineUrl(url, rendered));
			}
			await replaceWatchRows(db, menuId, rows, today);
			const ok = rows.filter((r) => r.fetch_status === 'ok');
			console.error(`✓ ${meta.name}: ${ok.length}/${rows.length} url(s) fingerprinted`);
			for (const row of rows) {
				if (row.fetch_status !== 'ok') {
					console.error(
						`    ${row.fetch_status}: ${row.url} — menu stays on the agent path until ` +
							`this url is fixed or curated out (--urls)`
					);
				}
			}
		}
	} finally {
		await rendered.close();
	}
	process.exit(failures > 0 ? 1 : 0);
}
