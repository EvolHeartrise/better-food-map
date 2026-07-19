// Pre-flight gate for the menu-refresh workflow: prove which stale menus'
// sources are UNCHANGED — for the cost of a few fetches instead of a full
// agent extraction — and emit the ones that actually need agent work.
//
//   bun run menu:check [--limit N] [--scan M] [--max-age-days D] [--recheck-days R]
//
// Scans menus stalest-first (same ordering the workflow's selection agent
// uses), fingerprints each menu's watch urls (menu_watch_urls, written by
// baseline.ts after every refresh) and buckets each menu:
//   needs_refresh     changed / unfetchable / never-baselined / past the
//                     full-refresh floor — hand these to the menu-refresh
//                     workflow as its `menus` arg.
//   unchanged         every watch row hash-stable; menus.last_checked stamped.
//                     NOT last_verified — hash-stability can't see a page
//                     newly added to the site nav, so verification age keeps
//                     accruing and --max-age-days (default 180) eventually
//                     forces a real agent pass regardless.
//   recently_checked  last_checked within --recheck-days (default 7); skipped
//                     without fetching so quiet menus don't re-fetch every run.
//
// Scanning stops once `--limit` menus need refresh; JSON report on stdout,
// progress on stderr. Every failure fails OPEN into needs_refresh — this gate
// can only ever save agent work, never lose a real change silently.

import { decideMenu, type FetchOutcome, type WatchRow } from './decide';
import { fingerprintUrl, RenderedFetcher } from './fetcher';
import { openDb, staleMenus, stampLastChecked, touchStableRows, watchRowsFor } from './db';
import type { StaleMenu } from './db';

interface Flagged extends StaleMenu {
	reason: string;
	urls?: string[];
}

function daysSince(today: string, iso: string): number {
	return Math.floor((Date.parse(today) - Date.parse(iso)) / 86_400_000);
}

/** Oldest a row's conditional-GET validators may get before a full re-fetch is forced. */
const REVALIDATE_DAYS = 30;

export async function runCheck(opts: {
	limit: number;
	scan: number;
	maxAgeDays: number;
	recheckDays: number;
	today: string;
}) {
	const db = openDb();
	const menus = await staleMenus(db, opts.scan);
	const watch = await watchRowsFor(
		db,
		menus.map((m) => m.menu_id)
	);
	const needs_refresh: Flagged[] = [];
	const unchanged: StaleMenu[] = [];
	const recently_checked: StaleMenu[] = [];
	let scanned = 0;
	const rendered = new RenderedFetcher();
	try {
		for (const menu of menus) {
			if (needs_refresh.length >= opts.limit) break;
			scanned++;
			const flag = (reason: string, urls?: string[]) => {
				needs_refresh.push({ ...menu, reason, ...(urls ? { urls } : {}) });
				console.error(`  → ${menu.menu_name}: ${reason}${urls ? ` (${urls.join(', ')})` : ''}`);
			};

			// Full-refresh floor: hash-stability cannot see nav-added pages or our
			// own past extraction errors, so verification age forces a real pass.
			// (Null last_verified is defensive only — migration 0012 backfilled and
			// its triggers forbid it — but a null must obviously refresh.)
			if (menu.last_verified === null) {
				flag('never_verified');
				continue;
			}
			if (daysSince(opts.today, menu.last_verified) > opts.maxAgeDays) {
				flag('full_refresh_floor');
				continue;
			}
			const rows: WatchRow[] = watch.get(menu.menu_id) ?? [];
			if (rows.length === 0) {
				flag('no_fingerprints');
				continue;
			}
			if (
				menu.last_checked !== null &&
				daysSince(opts.today, menu.last_checked) < opts.recheckDays
			) {
				recently_checked.push(menu);
				continue;
			}

			const outcomes: FetchOutcome[] = await Promise.all(
				rows.map((row) => {
					// A lying validator (etag reuse across deploys, CDN-stale
					// Last-Modified) would let 304s coast on unseen content forever;
					// periodically force an unconditional fetch so a 304 can never
					// outrun REVALIDATE_DAYS.
					const stale =
						row.checked_at !== undefined && daysSince(opts.today, row.checked_at) > REVALIDATE_DAYS;
					return fingerprintUrl(
						stale ? { ...row, etag: null, last_modified: null } : row,
						rendered
					);
				})
			);
			const decision = decideMenu(rows, new Map(outcomes.map((o) => [o.url, o])));
			if (decision.verdict === 'unchanged') {
				// A failed stamp is only lost bookkeeping — the menu re-checks (and
				// mostly 304s) next run — so it must not abort the rest of the sweep.
				try {
					await touchStableRows(db, menu.menu_id, outcomes, opts.today);
					await stampLastChecked(db, menu.menu_id, opts.today);
				} catch (e) {
					console.error(`  warning: failed to stamp ${menu.menu_name}: ${String(e)}`);
				}
				unchanged.push(menu);
				console.error(`  ✓ ${menu.menu_name}: unchanged (${rows.length} url(s))`);
			} else {
				flag(decision.reason ?? 'needs_refresh', decision.urls);
			}
		}
	} finally {
		await rendered.close();
	}
	return {
		as_of: opts.today,
		scanned,
		scan_exhausted: scanned === menus.length && needs_refresh.length < opts.limit,
		needs_refresh,
		unchanged,
		recently_checked
	};
}

function intFlag(args: string[], name: string, fallback: number): number {
	const i = args.indexOf(name);
	if (i === -1) return fallback;
	if (i + 1 >= args.length) {
		console.error(`${name} expects a value`);
		process.exit(1);
	}
	const n = Number(args[i + 1]);
	if (!Number.isInteger(n) || n <= 0) {
		console.error(`${name} expects a positive integer, got "${args[i + 1]}"`);
		process.exit(1);
	}
	return n;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const limit = intFlag(args, '--limit', 10);
	const opts = {
		limit,
		scan: intFlag(args, '--scan', Math.max(40, limit * 4)),
		maxAgeDays: intFlag(args, '--max-age-days', 180),
		recheckDays: intFlag(args, '--recheck-days', 7),
		today: new Date().toISOString().slice(0, 10)
	};
	console.error(
		`checking up to ${opts.scan} stalest menus for ${opts.limit} needing refresh (as of ${opts.today})…`
	);
	const report = await runCheck(opts);
	console.error(
		`scanned ${report.scanned}: ${report.needs_refresh.length} need refresh, ` +
			`${report.unchanged.length} unchanged (stamped), ${report.recently_checked.length} recently checked`
	);
	if (report.scan_exhausted) {
		// Stable menus keep their staleness rank (last_verified never advances on
		// an unchanged check), so they occupy the scan window every run — a
		// changed menu just past it is only reachable by widening the window.
		console.error(
			`note: scan window exhausted below --limit; raise --scan (${opts.scan}) to look deeper into the backlog`
		);
	}
	console.log(JSON.stringify(report, null, '\t'));
}
